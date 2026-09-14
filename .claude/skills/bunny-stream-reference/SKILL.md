---
name: bunny-stream-reference
description: >-
  Bunny.net Stream domain reference for this app: the Stream API call, the TWO
  token-signing schemes (embed view token vs pull-zone CDN token — different
  keys, different encodings), URL anatomy, expiry semantics, and 403 failure
  signatures. Load when working on lib/bunny.js, /api/videos, embed playback,
  thumbnails, BUNNY_* env vars, or any Bunny 401/403. Do NOT load for email
  problems (email-delivery-reference), general app operation
  (bunny-sharing-run-and-operate), or step-by-step incident triage
  (bunny-sharing-debugging-playbook — this skill is the domain background it
  leans on).
---

# Bunny Stream Reference (as used by THIS app)

All Bunny.net Stream knowledge a zero-context session needs to work on this
repo. Everything here is grounded in `lib/bunny.js` (the ONLY file that talks
to Bunny) and `README.md`. This is how Bunny works *as applied here*, not a
general Bunny textbook.

## 1. Concept glossary

| Term | Definition (one line) |
| --- | --- |
| Stream library | A Bunny.net container for videos, identified by `BUNNY_LIBRARY_ID`; has its own API key and its own token-auth key. |
| Video GUID | The unique ID of one video inside a library (e.g. `6ac9c3fc-90b7-...`); this app stores it as `videoId` in share records and exposes it as `id` from `/api/videos`. |
| Pull zone | The CDN hostname that serves a library's raw assets (thumbnails, HLS, MP4), e.g. `vz-xxxxxxxx-abc.b-cdn.net`; configured here as `BUNNY_PULL_ZONE`. |
| Embed view token authentication | Bunny's scheme for gating the iframe player at `iframe.mediadelivery.net`: URL must carry `?token=<sha256 hex>&expires=<unix>`. Signed with `BUNNY_TOKEN_KEY`. |
| Pull-zone token authentication | Bunny's separate scheme for gating direct CDN asset URLs on the pull zone: `?token=<sha256 base64url>&expires=<unix>`. Signed with `BUNNY_CDN_TOKEN_KEY`. Optional — only if enabled on the pull zone. |
| AccessKey header | The HTTP header carrying the library API key (`BUNNY_API_KEY`) on Stream API calls. Literally `AccessKey: <key>`, not `Authorization`. |

## 2. The app's three Bunny touchpoints

`lib/bunny.js` is the entire Bunny surface. Three operations:

### (a) List videos — `listVideos()` (lib/bunny.js:6-30)

```
GET https://video.bunnycdn.com/library/<BUNNY_LIBRARY_ID>/videos?page=<N>&itemsPerPage=100&orderBy=date
Headers: AccessKey: <BUNNY_API_KEY>
         accept: application/json
```

- Non-OK response → throws `Bunny API error: <status> <body>`; `/api/videos`
  catches it and returns 500 with that message (pages/api/videos.js:8-10).
- Maps `data.items[]` to `{ id: guid, title, length, thumbnail }`.
- `thumbnail` is a signed pull-zone URL only if `BUNNY_PULL_ZONE` is set;
  otherwise `null` (lib/bunny.js:26-28).
- **Pagination (fixed 2026-09-13, `5eb7245`).** Until then `itemsPerPage=100`
  was a hard ceiling with no `page` param, so a library over 100 videos
  silently showed only the first page (newest first via `orderBy=date`) and
  video #101 could never be shared. `lib/bunny.js` now walks pages via a
  shared `listAllPages()` helper — `page=N&itemsPerPage=100` — stopping on a
  short/empty page OR once `totalItems` is reached, with a `MAX_PAGES=200`
  hard stop against a malformed `totalItems`. A library at or under one page
  still makes exactly ONE request. The same walker backs
  `listCollections()`. Caveat: verified against a stubbed API that reports
  `totalItems` honestly, never against a real 100+ library.

### (b) Embed URL signing — `generateEmbedUrl(videoId, expiresInSeconds)` (lib/bunny.js:56-65)

Called from `pages/watch/[token].js:171` with a 3600 s window at page render.
Produces the iframe player URL for authorized viewers. Scheme details in
section 3.

### (c) CDN URL signing — `signCdnUrl(url, expiresInSeconds)` (lib/bunny.js:40-52)

Internal (not exported); called only from `listVideos` to sign thumbnail URLs
`https://<BUNNY_PULL_ZONE>/<guid>/<thumbnailFileName>`. If
`BUNNY_CDN_TOKEN_KEY` is unset it returns the URL unsigned (lib/bunny.js:42) —
correct when pull-zone Token Authentication is off, a 403 when it is on.

## 3. THE TWO SIGNING SCHEMES — side by side

**The keys are NOT interchangeable and the digest encodings differ.** Using
one key/encoding where the other belongs produces URLs that look plausible and
403. This exact confusion caused incident 65dc992 ("Fix thumbnails 403ing when
pull zone token auth is enabled") — see bunny-sharing-failure-archaeology.

| | Embed view token (player) | Pull-zone CDN token (thumbnails etc.) |
| --- | --- | --- |
| Function | `generateEmbedUrl` (lib/bunny.js:56) | `signCdnUrl` (lib/bunny.js:40) |
| Key env var | `BUNNY_TOKEN_KEY` | `BUNNY_CDN_TOKEN_KEY` (optional) |
| Where the key lives in the Bunny dashboard | Stream library's Embed View Token: Library > API > Security (lib/bunny.js:36-37) | The pull zone's own key: Library > API > "CDN zone management" > Manage > Security > Token Authentication (lib/bunny.js:38-39; README env table; .env.example) |
| Hash input string | `key + videoId + expires` | `key + pathname + expires` (pathname = URL path incl. leading `/`, e.g. `/<guid>/thumbnail.jpg`; no query, no host) |
| Digest | SHA-256 | SHA-256 |
| Encoding | **hex** (lib/bunny.js:62) | **base64url**: base64 with `+`→`-`, `/`→`_`, `=` stripped (lib/bunny.js:48-49) |
| URL produced | `https://iframe.mediadelivery.net/embed/<libraryId>/<videoId>?token=<hex>&expires=<unix>` | `<origin><pathname>?token=<b64url>&expires=<unix>` on the pull zone host |
| Consumed by | The `<iframe>` on `/watch/<token>` after email-gate grant | `<img src>` thumbnails in the admin grid (pages/index.js:160) |
| What 403s when wrong | Player iframe renders but shows a 403/auth error inside; the surrounding page is fine | Broken images — each `<img>` request gets 403 from the CDN |
| `expires` format | Unix seconds, same in hash input and query param | Same |

Sanity fingerprint: an embed token is 64 lowercase hex chars; a CDN token is
43 base64url chars (`A-Za-z0-9_-`). If a token's alphabet doesn't match its
URL type, the wrong scheme was used.

## 4. Worked example — verify a token by hand

Given key `K`, video GUID `V`, unix expiry `E`. These mirror lib/bunny.js
exactly (verified by cross-running against `generateEmbedUrl` on 2026-07-18).

**Embed token (hex):**

```bash
node -e 'const c=require("crypto");const K="mykey",V="6ac9c3fc-90b7-4c17-a3a3-1234567890ab",E=1789999999;console.log(c.createHash("sha256").update(K+V+E).digest("hex"))'
# -> 0057b6956958661531af719f9cb47bc66ec59a9d84be8076287b7a00086cc61a  (for these sample inputs)
```

**CDN token (base64url), P = pathname of the asset:**

```bash
node -e 'const c=require("crypto");const K="mycdnkey",P="/6ac9c3fc-90b7-4c17-a3a3-1234567890ab/thumbnail.jpg",E=1789999999;let t=c.createHash("sha256").update(K+P+E).digest("base64");t=t.replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");console.log(t)'
# -> vXjarGfZ2J4mqwOdJg6RuohAx3Jl7yrck2lmosmwidw  (for these sample inputs)
```

To check a real URL: pull `token` and `expires` from its query string,
substitute your real key plus the videoId (embed) or pathname (CDN) and the
URL's own `expires` value into the matching one-liner, and compare output to
the URL's `token`. Mismatch = wrong key or wrong scheme; match but still 403 =
expired (`expires` < now) or token auth settings changed on Bunny's side.

## 5. Expiry semantics — three independent clocks

| Clock | Duration | Set when | Source |
| --- | --- | --- | --- |
| Embed URL | 3600 s | At `/watch/<token>` page render (server side) | pages/watch/[token].js:171 |
| Share record | `hours` chosen at share time (default 72 h) | At share creation; stored as `expiresAt` in the KV record | lib/shares.js |
| Thumbnail URLs | 3600 s | At `listVideos()` call time | lib/bunny.js:40 default |

These are independent. Consequences:

- A share valid for days still serves embed URLs signed for only 1 h — fine,
  because each page load re-signs. A viewer who keeps the tab open past 1 h
  and whose player re-fetches may hit 403; a refresh fixes it (their grant
  cookie persists until share expiry).
- An admin tab left open past 1 h shows dead (403) thumbnails because they
  were signed at list time. **Refresh the page** — this is expected behavior,
  not an outage. Only applies when `BUNNY_CDN_TOKEN_KEY` is in play.
- Revocation and share expiry are enforced by the app (KV record checks),
  never by Bunny — Bunny only enforces the URL-level `expires`.

## 6. Failure signatures (Bunny-specific 4xx triage)

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `/api/videos` returns 500 with `Bunny API error: 401 ...` | Wrong/missing `BUNNY_API_KEY` (AccessKey header rejected by the Stream API) | Use the Stream **library** API key, not an account key |
| `/api/videos` returns 500 with `Bunny API error: 404 ...` | Wrong `BUNNY_LIBRARY_ID` | Check library ID in dashboard |
| Watch page renders, but the player iframe shows 403 inside | Embed token rejected: wrong `BUNNY_TOKEN_KEY` (e.g. CDN key pasted there), or embed `expires` passed | Verify with the section 4 embed one-liner; confirm key is the Library > API > Security one |
| Admin grid loads, thumbnails all broken (img 403) | Pull-zone Token Authentication is enabled but `BUNNY_CDN_TOKEN_KEY` unset/wrong — or the hex encoding was used for a CDN token | Set the pull zone's own key; verify with the CDN one-liner |
| Thumbnails 403 only after tab open > 1 h | Signed-URL expiry, not a config problem | Refresh (section 5) |
| Video missing from admin grid, plays fine by direct GUID | Was the `itemsPerPage=100` ceiling (section 2a) | FIXED 2026-09-13 — pagination walks every page. If a video is still missing on a build at/after `5eb7245`, this is NOT the cause: check the Bunny API response itself (`grep -n "page=" lib/bunny.js` to confirm the walker is present), then the admin table's own status filter, which is a separate and newer way to not-see a row |

For full incident triage flow (which experiment to run first, cross-surface
symptoms), go to **bunny-sharing-debugging-playbook** — this section only
gives the Bunny-side signatures it discriminates between.

## When NOT to use this skill

- Email delivery, Resend vs SMTP, deliverability → **email-delivery-reference**.
- Running the app, admin/recipient flows, KV conventions, cleanup/cron →
  **bunny-sharing-run-and-operate**.
- Step-by-step debugging of a live incident → **bunny-sharing-debugging-playbook**
  (it references this skill for the signing math).
- Env-var setup from scratch → **bunny-sharing-env-and-setup**.

## Provenance and maintenance

Facts verified against the repo on 2026-07-18 (branch
claude/bulk-share-separate-links-auth-cblrle, 5905bba). Re-verify before trusting:

- Signing math and dashboard-location comments: `grep -n "sha256\|digest\|Security" lib/bunny.js`
- List endpoint and 100-item ceiling: `grep -n "itemsPerPage" lib/bunny.js`
- Embed call site and 3600 s window: `grep -n "generateEmbedUrl" pages/watch/\[token\].js`
- CDN key dashboard wording: `grep -n "CDN zone management" README.md .env.example lib/bunny.js`
- Incident reference: `git log --oneline 65dc992 | head -1`
- One-liners still mirror the lib: run the section 4 commands and compare
  against a URL produced with the same key/inputs by `generateEmbedUrl`.
