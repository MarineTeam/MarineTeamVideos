---
name: bunny-sharing-run-and-operate
description: >
  Operate the bunny-sharing app: run dev/build/start, understand the admin,
  recipient, and bundle-listing user journeys end-to-end (what happens
  server-side at each step), KV data conventions
  (bunnyshare:/gatethrottle:/bunnybundle:/bundlethrottle:/gateused:/gateip:/accessreq: keys), and the operating
  runbook — revoke shares, extend a share's expiry, resend, inspect shares,
  run cleanup, rotate GATE_SECRET or ADMIN_PASS, deploy to Vercel. Load this
  when running the app, answering "how
  does the flow work", or performing routine admin/ops tasks on a working
  deployment. Do NOT load for first-time environment/env-var setup
  (bunny-sharing-env-and-setup), for diagnosing failures
  (bunny-sharing-debugging-playbook), or for measuring/probing live systems
  (bunny-sharing-diagnostics).
---

# Run and operate bunny-sharing

Runbook for running the app locally, understanding both user journeys as
built, knowing where state lives, and doing routine operations. Everything
below was verified against the source on 2026-07-18. All commands assume
`cwd` = repo root (`/home/user/bunny-sharing` in the dev container; adjust to
wherever the repo is checked out).

Jargon used once, defined once:

- **Share record** — one JSON blob in Upstash Redis representing one
  video-to-one-recipient share, keyed by an unguessable token.
- **Magic link** — a short-lived (15 min) signed URL emailed to a recipient so
  they can prove control of the email a share was sent to.
- **Grant** — a stateless HMAC-SHA256-signed string (`lib/gate.js`) carried
  either in a magic link's `?grant=` query param or in a per-share cookie.
- **KV** — Upstash Redis reached over its REST API (`lib/kv.js`). This is the
  app's ONLY datastore.

## 1. Command anatomy

There are exactly three npm scripts (`package.json`); no test, lint, or other
scripts exist.

| Command | What it does |
| --- | --- |
| `npm run dev` | `next dev` — dev server on http://localhost:3000. Needs a populated `.env.local` for anything real to work (Basic Auth env vars, Bunny, KV, email, GATE_SECRET). If env vars are missing, see bunny-sharing-env-and-setup. |
| `npm run build` | `next build` — production build with Turbopack (Next.js 16.2.10). **Needs NO env vars**: all config is read at request time, and `lib/gate.js`'s fail-loud `GATE_SECRET` check is runtime-only. Verified 2026-07-18: build succeeds in a shell with no `.env.local` and no env vars set. |
| `npm run start` | `next start` — serves the production build on port 3000. Run `npm run build` first. This DOES need env vars to serve real traffic. |

### Expected build output (as of 2026-07-21, next 16.2.10)

A healthy build prints this exact route manifest — 17 routes plus the
middleware line:

```
Route (pages)
┌ ○ /
├ ○ /404
├ ƒ /api/bundle/request-link
├ ƒ /api/cleanup
├ ƒ /api/revoke
├ ƒ /api/revoke-bulk
├ ƒ /api/share
├ ƒ /api/share-bulk
├ ƒ /api/share/extend
├ ƒ /api/share/extend-bulk
├ ƒ /api/share/resend
├ ƒ /api/share/resend-bulk
├ ƒ /api/shares
├ ƒ /api/videos
├ ƒ /api/watch/request-link
├ ƒ /api/watch/track
├ ƒ /bundle/[bundleId]
└ ƒ /watch/[token]

ƒ Proxy (Middleware)
```

`○` = static, `ƒ` = server-rendered on demand. If a route is missing or a
page unexpectedly flips between `○` and `ƒ`, something changed in `pages/`.

### The deprecation warning is EXPECTED — do not "fix" it casually

Every build prints:

```
⚠ The "middleware" file convention is deprecated. Please use "proxy" instead. Learn more: https://nextjs.org/docs/messages/middleware-to-proxy
```

This is known and deliberate. `middleware.js` implements the Basic Auth
boundary with the matcher `["/", "/api/((?!watch/|bundle/).*)"]`
(middleware.js:29-32) — the security perimeter of the whole app. Renaming
`middleware.js` to `proxy.js` is a behavior-affecting change to that
perimeter and must go through bunny-sharing-change-control, with the matcher
invariant re-verified (all admin routes 401 without credentials; `/api/watch/*`
and `/watch/*` stay public). Never do it as a drive-by "fix the warning" edit.

## 2. The two user journeys (as built)

### 2a. ADMIN journey

1. **Open `/`** → the browser gets a 401 with `WWW-Authenticate: Basic
   realm="Admin"` from `middleware.js` and shows a Basic Auth prompt. Sign in
   with `ADMIN_USER` / `ADMIN_PASS` (exact string compare of the decoded
   `Authorization` header, middleware.js:12-21).
2. **Video grid loads** — `pages/index.js` fires `GET /api/videos` and
   `GET /api/shares` in parallel (`loadAll()`, pages/index.js:25-34).
   `/api/videos` calls Bunny's Stream API (`lib/bunny.js` `listVideos`,
   AccessKey header, `itemsPerPage=100` per page — paginated since
   2026-09-13, so a library over 100 videos now lists fully). Thumbnail URLs come from
   `BUNNY_PULL_ZONE` and, if `BUNNY_CDN_TOKEN_KEY` is set, are **signed**
   (`signCdnUrl` in lib/bunny.js — required when the pull zone has Token
   Authentication enabled; unsigned thumbnails 403 in that case).
3. **Single share** — click Share on a card → modal asks for recipient email
   + hours (default 72) → `POST /api/share` with
   `{videoId, videoTitle, email, hours}`. Server side
   (`pages/api/share.js`): `createShareRecord` (lib/shares.js) mints
   `token = crypto.randomBytes(16).toString("hex")`, writes the record to
   `bunnyshare:<token>`. The record is stored BEFORE the email is sent, so
   a send failure still leaves a live share record — as of 2026-07-20 this
   is flagged (`emailFailed`/`emailError`, shown as "⚠ email failed" in the
   shares table) rather than being a silent ghost. The Resend button
   (`/api/share/resend`, exporting `resendOne`) works on ANY active share, not
   only flagged ones — an admin can nudge a recipient who says they never got
   an email even if nothing failed — and clears the flag on success. Shares
   table rows also have select checkboxes and a "Resend N" bulk bar
   (`/api/share/resend-bulk`, `{tokens: [...]}` → `{succeeded, failures}`,
   never fails the whole selection on one bad token). Widened same day: the
   recipient's bundle is looked up/extended (`findOrExtendBundle`,
   lib/bundles.js) before sending — if this is their only active share, they
   get the plain `sendShareEmail`; if they already have any other active
   share (from a prior single OR bulk share, in either order), this one
   folds into ONE consolidated email (`sendBulkShareEmail`) listing
   everything currently active for them, with the bundle link, instead of
   becoming yet another standalone email (see 2c).
4. **Bulk share** — tick Select checkboxes on 2+ cards → a bulk bar appears
   with an emails field (comma/space/semicolon-separated, one or more) and
   ONE hours field → `POST /api/share-bulk` with
   `{videos: [{id, title}, ...], emails: [..], hours}` (legacy single
   `email` string still accepted). Server side (`pages/api/share-bulk.js`):
   loops recipients × videos, calls `createShareRecord` once per pair
   (skipping entries with falsy `id`; 400 if none valid) → **M×N distinct
   tokens, each independently revocable** — then finds-or-extends that
   recipient's `bunnybundle:<id>` record (`findOrExtendBundle`,
   lib/bundles.js — same call site 3 above uses, so a recipient's shares
   from either endpoint converge onto ONE bundle) and sends each recipient
   ONE consolidated email listing ALL of their currently active links (not
   just this call's — `getBundleItems` rebuilds the list from the bundle's
   full membership) plus a link to `/bundle/<id>` (see 2c below; added
   2026-07-20). A failed send for one recipient is reported in the response
   `failures` array without blocking the others (their records exist —
   resend or revoke). Invariant: bulk never reuses a token across pairs.
   Views are
   tracked per record (`viewCount`/`lastViewedAt`, shown in the shares
   table's Views column), and real playback separately
   (`playCount`/`maxProgressPct`/`completedAt` via `/api/watch/track`,
   shown in the Watched column: `—` / `started` / `NN%` / `100% ✓`) — so
   with per-recipient links you can see who opened AND who actually
   watched what.
5. **Shares table** — rendered from `GET /api/shares`
   (`pages/api/shares.js`: `KEYS bunnyshare:*`, fetch each, sort by
   `createdAt` desc). Status is NOT stored; it is derived client-side by
   `statusOf` (pages/index.js:112-116): `revoked` → "Revoked",
   `Date.now() > expiresAt` → "Expired", else "Active".
6. **Revoke** — the Revoke button (only shown for Active rows) confirms then
   `POST /api/revoke` with `{token}`. Server side (`revokeOne`,
   `pages/api/revoke.js`) sets `revoked: true` on the record and writes it
   back — a flag flip, never a delete (invariant: reversible/auditable);
   idempotent, so revoking an already-revoked record is a no-op success.
   Bulk form (added 2026-07-21, same select-checkboxes as bulk Resend/Extend
   above): "Revoke N" in the bulk bar → `POST /api/revoke-bulk` with
   `{tokens: [...]}` → `{succeeded, failures}` per token.
6a. **Extend** (added 2026-07-21) — the Extend button appears on every
   non-revoked row, Active OR Expired (unlike Revoke/Resend, which stay
   Active-only — extending an already-expired-but-not-revoked share is the
   main use case). Prompts for hours, then `POST /api/share/extend` with
   `{token, hours}`. Server side (`extendOne`, `pages/api/share/extend.js`):
   rejects a revoked record outright; otherwise sets
   `expiresAt = Math.max(Date.now(), record.expiresAt) + hours*3600*1000` in
   place — same token, same URL, same cookie. If the token belongs to a
   bundle, that bundle's own `expiresAt` is re-maxed too
   (`extendBundleForToken`, lib/bundles.js) so it doesn't lapse before this
   member. The bulk-select checkboxes (shared with bulk Resend, see item 3
   above) are also non-revoked-scoped, and an "Extend N" button sits next to
   "Resend N" in the bulk bar → `POST /api/share/extend-bulk` with
   `{tokens: [...], hours}` → `{succeeded, failures}` per token.
7. **Cleanup** — the "Clean up expired & revoked" button confirms then
   `POST /api/cleanup`. Server side scans `bunnyshare:*` and DELETES every
   record that is revoked or past `expiresAt`; also scans `bunnybundle:*`
   and deletes any past its own `expiresAt` (no `revoked` flag on bundles —
   see 2c). Returns `{deleted: <n>}` covering both. This is the only path
   that removes records.

**Shares table controls (added 2026-09-13).** The table is searched,
filtered by status and paged SERVER-side, so what you see is one page (50
rows) of a server-side query, not the whole store. Two consequences worth
internalizing: a share you just created may not be on the page you are
looking at if a filter is active, and the row count line reads "N of M" when
filtered. "⬇ Export CSV" exports everything the CURRENT filter selects,
unpaged. The Analytics panel is computed separately over every share
(`/api/analytics`), so it is NOT limited to the visible page.

### 2b. RECIPIENT journey

1. **Email link** — recipient clicks `<site>/watch/<token>` from the share
   email. This page is public (never matched by the middleware).
2. **Server loads the record** — `getServerSideProps` in
   `pages/watch/[token].js` reads `bunnyshare:<token>`. Missing → "Link not
   found." Revoked → "Access to this video has been revoked." Expired →
   "This link has expired." (each a terminal error page, no email form).
3. **Email form** — with a valid record and no grant, the page renders the
   EmailGate form. Recipient types their address → `POST
   /api/watch/request-link` with `{token, email}`.
4. **Uniform response** — `pages/api/watch/request-link.js` returns the SAME
   generic 200 ("If that email matches this link, we've sent a sign-in link
   to it.") for invalid/revoked/expired links, mismatched emails, throttled
   repeats, AND success. This anti-enumeration behavior is an invariant — do
   not add distinguishing responses. On an actual match it: checks/sets the
   `gatethrottle:<token>` marker (skip send if present), signs a 15-minute
   grant, and emails the magic link
   `<site>/watch/<token>?grant=<...>` (`sendMagicLinkEmail`).
5. **Magic-link click** — back in `getServerSideProps`: `?grant=` is
   verified (`verifyGrant`: timing-safe HMAC check, expiry check, bound to
   this token). Valid → the server signs a LONGER-lived cookie grant
   (expiring with the share) and sets cookie `gate_<token>` with `HttpOnly;
   Path=/watch/<token>; SameSite=Lax; Max-Age=<seconds until share expiry>`
   plus `Secure` when the request is https — then 307-redirects to the clean
   `/watch/<token>` URL so the grant leaves the address bar. Invalid/expired
   grant → email form again with a "That sign-in link has expired" notice.
6. **Playback** — on the clean URL with a valid cookie, the server calls
   `generateEmbedUrl(videoId, 3600)` (signed Bunny embed URL, 1-hour token)
   and renders the iframe player.
7. **Re-verification is per-share and per-browser** — the cookie is
   Path-scoped to exactly `/watch/<token>`, so a recipient with 3 bulk links
   verifies 3 times (once per link) UNLESS they instead verify once through
   the bundle page (2c) — that mints all 3 cookies in one go.
8. **The magic link is single-use** (added 2026-09-13). Step 5's exchange
   marks it spent, so clicking the same emailed link a second time lands on
   the email form with the SAME "that sign-in link has expired" notice a
   genuinely stale link produces. The cookie from the first click keeps
   working, so this is invisible to a normal recipient — it only bites
   someone re-clicking an old email instead of reloading the page, and the
   fix is the same either way: request a new link.
9. **Dead ends are now recoverable** (added 2026-09-13). A share past
   `expiresAt` (but NOT one you revoked, and not one that hit a `maxViews`
   cap) shows a "Request more time" form. Submitting the matching address
   emails `ADMIN_NOTIFY_EMAIL`; you then Extend, and their original link
   works again. Throttled to one per share per hour.

### 2c. BUNDLE journey (added 2026-07-20; widened same day to one-per-email)

A shortcut for the RECIPIENT journey once a recipient has more than one
active share: instead of re-verifying per video, one verification on the
bundle page unlocks all of them. Every recipient converges onto ONE bundle
over time — it's created (or found and extended) on their first share from
EITHER `/api/share` or `/api/share-bulk`, and every later share to that same
address (from either endpoint, in either order) adds to the same bundle
rather than spawning a new one.

1. **Bundle link** — recipient clicks `<site>/bundle/<bundleId>` (from the
   bulk-share email, alongside the per-video links). Public, never matched
   by the middleware.
2. **Server loads the bundle** — `pages/bundle/[bundleId].js` reads
   `bunnybundle:<bundleId>`. Missing → "Link not found." Past its
   `expiresAt` (the max of all members') → "This link has expired." No
   `revoked` check — bundles don't have one.
3. **Email form** — posts to `POST /api/bundle/request-link` with
   `{bundleId, email}`; same uniform generic-200 response as the per-video
   gate, same 15-min grant TTL, same 30 s throttle key
   (`bundlethrottle:<bundleId>`).
4. **Magic-link click** — grant is bound to pseudo-token `bundle:<bundleId>`
   (never collides with a real video token). Valid → the server mints a
   `gate_bundle_<bundleId>` cookie (Path=`/bundle/<bundleId>`) for the
   listing page **and**, for every member token, the exact same
   `gate_<token>` cookie the per-video journey would have produced
   (Path=`/watch/<token>`) — all in one Set-Cookie response. Redirects to
   the clean bundle URL.
5. **Listing** — with a valid bundle cookie, the page re-fetches every
   member's `bunnyshare:<token>` LIVE (never trusts a cached status) and
   lists each as a clickable link if active, or plain text `<title> —
   revoked`/`<title> — expired` otherwise.
6. **Clicking through** — because step 4 already minted that video's own
   cookie, opening any member's `/watch/<token>` plays immediately — no
   second email round-trip. Revoking a member still takes effect
   immediately regardless: `/watch/<token>` re-checks `revoked` on every
   render independent of the cookie (invariant 3, architecture-contract).

## 3. Data conventions: where state lives

**Nothing is stored on disk.** All app state lives in Upstash Redis (via
`KV_REST_API_URL`/`KV_REST_API_TOKEN`); videos and thumbnails live in
Bunny.net. A redeploy or container wipe loses nothing.

### Key: `bunnyshare:<token>` — share records (permanent until cleanup)

One JSON object per share, written by `createShareRecord` (lib/shares.js):

| Field | Type | Meaning |
| --- | --- | --- |
| `token` | string | 32 hex chars (`crypto.randomBytes(16)`), same as in the key and the `/watch/` URL |
| `videoId` | string | Bunny video GUID |
| `videoTitle` | string | Title at share time (falls back to `videoId`) |
| `email` | string | Recipient address, stored as typed (compared case-insensitively by the gate) |
| `createdAt` | number | ms epoch |
| `expiresAt` | number | ms epoch = createdAt + hours×3600×1000 (default 72 h) |
| `revoked` | boolean | `false` at creation; flipped to `true` by /api/revoke |
| `maxViews` | number (optional) | Added 2026-09-13. Cap on authorized page RENDERS (openings, not plays). Written only when a positive integer was given; absent = unlimited. Once `viewCount >= maxViews` the link stops rendering and the admin table shows "Used up". Nothing resets it — see roadmap (p) |
| `note` | string (optional) | Added 2026-09-13. Admin's message to the recipient, ≤500 chars, opens the notification email. Stored raw, escaped at render |

Several more optional fields exist for tracking, watermarking and email
failure — see architecture-contract 5.1 for the complete list. All are
additive: absent on older records, never assume present.

Do NOT rename the key prefix or field names — live links depend on them
(prime invariant: never break live links; see
bunny-sharing-architecture-contract).

### Key: `gatethrottle:<token>` — magic-link throttle markers (self-expiring)

Written by `pages/api/watch/request-link.js` via `kvSetEx(key, 1, 30)` —
value `1`, Redis `EX=30`, so it auto-expires after 30 seconds. While present,
repeat magic-link requests for that share silently skip the email send (the
response is still the generic 200). These keys never need manual cleanup.

### Key: `bunnybundle:<bundleId>` — bundle records (added 2026-07-20; one per email, not per call, as of same day)

One JSON object per recipient EMAIL (not per call) — written by
`createBundleRecord` the first time, then extended in place by
`findOrExtendBundle` (both in lib/bundles.js) on every later share to that
same address from either `/api/share` or `/api/share-bulk`:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | 32 hex chars, same as in the key and the `/bundle/` URL |
| `email` | string | The one recipient this bundle was created for; matched case/whitespace-insensitively (`normalizeEmail`, lib/gate.js) when deciding whether to extend vs create |
| `tokens` | array of string | Member share tokens, appended to over time — the truth for each member's title/status is ALWAYS re-read from its own `bunnyshare:<token>` record, never cached here |
| `createdAt` | number | ms epoch, set once at first creation |
| `expiresAt` | number | ms epoch = max of all members' `expiresAt`, re-maxed on every extend |

No `revoked` field — a bundle isn't itself revocable, only its members are
(via their own `bunnyshare:` records). Deleted by `/api/cleanup` once past
`expiresAt`. When creating the FIRST bundle for an email, `findOrExtendBundle`
also sweeps in other still-active `bunnyshare:*` records for that email not
already claimed by another bundle, so the initial bundle reflects everything
currently shared with that person, not only the share that triggered its
creation.

### Key: `bundlethrottle:<bundleId>` — bundle magic-link throttle (self-expiring)

Same shape and purpose as `gatethrottle:<token>`, written by
`pages/api/bundle/request-link.js`.

### Keys added 2026-09-13 (`5eb7245`) — all self-expiring, all fail-open

None of these is part of the compatibility contract. Every one degrades to
the app's previous behaviour if the store errors, so you can flush any of
them without breaking a live link — you only lose the protection until it
rebuilds.

| Key | Value / TTL | Written by | What flushing it does |
|---|---|---|---|
| `gateused:<sha256(grant)>` | `1`, TTL = the grant's remaining life | `lib/singleUse.js` at the grant→cookie exchange | Makes already-used magic links replayable again for their remaining minutes. Harmless in practice, but it is the single-use protection, so do not flush casually |
| `gateip:<ip>` | request count, `EX=60` | `lib/rateLimit.js` on all three public POST endpoints | Resets one sender's minute quota. Useful if you have rate-limited yourself while testing |
| `accessreq:<token>` | `1`, `EX=3600` | `pages/api/watch/request-access.js` | Lets a recipient re-request access on that share before the hour is up |
| `gatelog:<padded-ms>-<rand>` | the exchange entry, `EX=90 days` | `lib/gateLog.js` at each grant exchange | Destroys audit history. This is the one here you should NOT flush casually — it is evidence, not a protection |

Operationally the one you will actually reach for is `gateip:<ip>` — testing
the gate repeatedly from one machine WILL trip the 10/min cap, and the
symptom is deliberately invisible: you get the same "if that email
matches..." response as always, and no email arrives. If magic links stop
arriving during a test session and nothing else changed, check this before
suspecting the mailer.

## 4. Operating tasks runbook

All admin API calls require Basic Auth. Set once per shell:

```bash
export SITE=https://your-deployment.example   # or http://localhost:3000
export ADMIN_USER=... ADMIN_PASS=...
```

### Inspect all shares

```bash
curl -u "$ADMIN_USER:$ADMIN_PASS" "$SITE/api/shares"
```

Returns `{"shares":[...]}` sorted newest-first. Remember status
(Active/Expired/Revoked) is not a field — derive it: `revoked` true →
Revoked; `expiresAt < now-ms` → Expired; else Active.

### Revoke a share

UI: `/` → Shared Links table → Revoke button on the Active row. Or:

```bash
curl -u "$ADMIN_USER:$ADMIN_PASS" -X POST "$SITE/api/revoke" \
  -H "Content-Type: application/json" \
  -d '{"token":"<32-hex-token>"}'
```

`{"ok":true}` on success; 404 `{"error":"Share not found"}` for an unknown
token. Effect is immediate: the `/watch` page checks `record.revoked` on
every request, so even a recipient holding a valid cookie is blocked on next
load. Revoke does not delete the record (reversible by design — flipping the
flag back via KV restores access, though no endpoint does that today).
Idempotent: revoking an already-revoked token returns `{"ok":true}` again,
not an error.

Bulk form (added 2026-07-21): UI same select-checkboxes as bulk
Resend/Extend, "Revoke N" button in the bulk bar. Or:

```bash
curl -u "$ADMIN_USER:$ADMIN_PASS" -X POST "$SITE/api/revoke-bulk" \
  -H "Content-Type: application/json" \
  -d '{"tokens":["<t1>","<t2>",...]}'
```

`{"succeeded":["<t1>",...],"failures":[{"token","error"}...]}` — one
nonexistent or already-revoked token never blocks the rest (already-revoked
counts as `succeeded`, not a failure).

### Extend a share's expiry (added 2026-07-21)

UI: `/` → Shared Links table → Extend button on any non-revoked row (Active
or Expired). Or:

```bash
curl -u "$ADMIN_USER:$ADMIN_PASS" -X POST "$SITE/api/share/extend" \
  -H "Content-Type: application/json" \
  -d '{"token":"<32-hex-token>","hours":24}'
```

`{"ok":true,"expiresAt":<new-ms>}` on success. 404 for an unknown token; 400
`{"error":"Cannot extend a revoked share"}` for a revoked one — extend never
doubles as an un-revoke. Works on an already-expired share (extends from
`Date.now()`, not the stale old expiry). Bulk form:
`POST /api/share/extend-bulk` with `{"tokens":["<t1>","<t2>",...],"hours":24}`
→ `{"succeeded":[{"token","expiresAt"}...],"failures":[{"token","error"}...]}`,
one bad token never blocks the others. If the token is part of a bundle
(lib/bundles.js), that bundle's own `expiresAt` is extended too, so its
listing page doesn't lapse before this member does.

### Raise a share's view cap (added 2026-09-13)

A share with a `maxViews` cap that has been opened that many times shows as
"Used up" and stops rendering. To give the recipient more openings WITHOUT
minting a new token:

```bash
curl -s -u "$ADMIN_USER:$ADMIN_PASS" -X POST "$SITE_URL/api/share/allow-views" \
  -H 'Content-Type: application/json' \
  -d '{"token":"<token>","views":5}'
# {"ok":true,"maxViews":7,"viewCount":2}
```

Or "+ Views" on the row in the admin table; a bulk button sits beside
Extend. Things to know before reaching for it:

- It RAISES the cap, it does not reset the count. `viewCount` is the audit
  trail and an analytics input, so it is never rewritten. The response tells
  you both numbers.
- It refuses a REVOKED share (`Cannot raise the view limit on a revoked
  share`) — use Restore first if that is really what you want.
- It refuses a share with NO cap (`This share has no view limit`) — that
  share is already unlimited. There is deliberately no way to ADD a cap to
  an existing share or to remove one; both are policy changes rather than
  grants, and neither has been asked for.
- Extend and this are independent: a share can be live on time and used up
  on views, or vice versa. Check which limit actually stopped it before
  picking an action.

### Read the gate audit log (added 2026-09-13)

Every time someone actually passes the email gate and receives a cookie —
on a `/watch` page or a `/bundle` page — one entry is written. Use it to
answer "who got in, when, from where" after a leak or a complaint.

```bash
curl -s -u "$ADMIN_USER:$ADMIN_PASS" "$SITE_URL/api/gate-log?limit=50" | jq .
# {"exchanges":[{"at":1757..., "kind":"watch", "token":"<token>",
#                "emailHash":"9f2a...", "ip":"203.0.113.7"}], "count":1}
```

Reading it:

- **Emails appear only as a fingerprint.** To turn one into an identity,
  look up the share record for that token (`kv-inspect --token <token>`).
  The log deliberately holds less than the records do — see
  architecture-contract 2.4b.
- **To check whether an exchange was the intended recipient**, fingerprint
  the record's address and compare:
  `node -e 'import("./lib/gateLog.js").then(m=>console.log(m.emailFingerprint("them@example.com")))'`
- **To spot one person across several shares**, group by `emailHash`.
- **`kind`** is `watch` or `bundle`; a bundle exchange mints cookies for
  every member, so one bundle entry can explain access to many videos.
- **Entries expire after 90 days.** An empty log for an old incident means
  the window passed, not that nothing happened.
- **A gap is possible and is not tampering.** Log writes are best-effort by
  design so they can never break a sign-in; a KV blip loses an entry while
  the exchange itself succeeds.

### Run cleanup manually

```bash
curl -u "$ADMIN_USER:$ADMIN_PASS" -X POST "$SITE/api/cleanup"
```

Returns `{"deleted":<n>}`. Deletes only revoked-or-expired records; active
shares are never touched.

### Cleanup on a schedule — NOT configured yet (verified 2026-07-18)

The README's Deployment section says only that you can "optionally schedule
`/api/cleanup` (e.g. a Vercel Cron job)" — it is stated as an intent, not a
setup. There is **no `vercel.json` in the repo**, so no cron schedule is
actually configured. If you add one, know the as-built constraints before
assuming it works:

- `pages/api/cleanup.js` accepts POST only (405 otherwise), and Vercel Cron
  invokes endpoints with GET (Vercel-documented behavior as of 2026-07-18).
- `/api/cleanup` sits behind the Basic Auth middleware, which a bare cron
  request will fail with 401.

So a naive `vercel.json` crons entry will NOT work as-built; making it work
is a code change (method/auth handling) → route through
bunny-sharing-change-control. Until then, cleanup is manual (button or curl).
Skipping cleanup is safe operationally — stale records just accumulate and
show as Expired/Revoked rows; the cost is a growing `KEYS bunnyshare:*` scan.

### Rotate GATE_SECRET (the emergency lever)

Change `GATE_SECRET` in the deployment env and redeploy/restart.
Consequence, from how `lib/gate.js` signs both artifacts with the same
secret:

- **Instantly invalidated:** every outstanding magic link (unclicked
  `?grant=` URLs) and every viewer cookie (`gate_<token>`). Grants signed
  with the old secret fail `verifyGrant` and recipients drop back to the
  email form.
- **Still working:** the share links themselves. `bunnyshare:*` records and
  `/watch/<token>` URLs don't involve GATE_SECRET — recipients simply
  re-verify their email and keep watching.

This makes rotation the documented cheap emergency response to a suspected
grant/cookie leak: it costs every active viewer one email round-trip and
nothing else. It does NOT revoke any share — use /api/revoke for that.

### Rotate ADMIN_PASS (and/or ADMIN_USER)

Change the env var(s) in the deployment and redeploy/restart. Effect is
immediate — the middleware compares against the env on every request, so old
credentials get 401 on the next hit and browsers re-prompt. No sessions or
tokens exist to invalidate. Recipients are unaffected (`/watch/*` and
`/api/watch/*` never see Basic Auth). Anyone using the curl runbook above
must update their exported `ADMIN_PASS`.

## 5. Deploy

- **Target: Vercel**, per the README's Deployment section — "deploys as a
  standard Next.js app". Set every env var in the Vercel dashboard (the full
  catalog and which are required is in bunny-sharing-env-and-setup); the
  Upstash Redis KV can come from the Vercel Storage/marketplace tab or a
  standalone upstash.com database — both expose the same
  `KV_REST_API_URL`/`KV_REST_API_TOKEN`.
- **There is no CI/CD in this repo** (no `.github/workflows/`, verified
  2026-07-18; scanners were tried and removed — see
  bunny-sharing-failure-archaeology). Deploys are whatever Vercel's git
  integration does on push: no tests, no gates, no checks run first.
  Pre-push verification is therefore manual — follow
  bunny-sharing-change-control before pushing anything.
- **Local prod-mode test** before pushing:

  ```bash
  npm run build && npm run start
  ```

  then exercise both journeys against http://localhost:3000 with a real
  `.env.local`. This is the closest local approximation of the Vercel
  runtime.

## When NOT to use this skill

- **First-time environment creation** (getting Bunny/Upstash/Resend
  credentials, writing `.env.local`, env-var traps) →
  `bunny-sharing-env-and-setup`.
- **Something is failing** (401s, 403 thumbnails, emails not arriving, KV
  errors, gate loops) → `bunny-sharing-debugging-playbook`.
- **Measuring or probing** (KV inspection scripts, gate self-test, email or
  Bunny probes) → `bunny-sharing-diagnostics`.
- Changing behavior rather than operating it → `bunny-sharing-change-control`
  first; architecture rationale → `bunny-sharing-architecture-contract`.

## Provenance and maintenance

Every fact above was read from the repo at branch
`claude/bulk-share-separate-links-auth-cblrle` on 2026-07-18; the route
manifest, cleanup, bulk-share, and bundle (2c) sections were updated
2026-07-20 alongside `lib/bundles.js`/`pages/bundle/[bundleId].js`, then
updated again same day when bundles widened to one-per-email
(`findOrExtendBundle`) and `/api/share.js` started participating too. Item
6a and the "Extend a share's expiry" runbook section added 2026-07-21 for
`pages/api/share/extend.js`/`extend-bulk.js`. Item 6's bulk-revoke text and
"Revoke a share" runbook's bulk section added same day for
`pages/api/revoke-bulk.js`.
Re-verify
before trusting, in one line each:

| Claim | Re-verify with |
| --- | --- |
| npm scripts are exactly dev/build/start | `cat package.json` |
| Route manifest (17 routes) + middleware deprecation warning | `npm run build` (compare output to section 1) |
| Build needs no env vars | `env -i PATH="$PATH" HOME="$HOME" npm run build` in a checkout with no `.env.local` |
| Basic Auth matcher / public routes | `cat middleware.js` (matcher at bottom, expect `(?!watch/\|bundle/)`) |
| Share record fields + key prefix | `grep -n "bunnyshare" lib/shares.js pages/api/*.js pages/watch/*.js` and read `createShareRecord` in `lib/shares.js` |
| Throttle key, TTL 30 s, magic-link TTL 15 min | `grep -n "THROTTLE_SECONDS\|MAGIC_LINK_TTL_MS\|gatethrottle" pages/api/watch/request-link.js` |
| Cookie name/scope/flags | `grep -n "Set-Cookie\|cookieName" "pages/watch/[token].js"` |
| Status derived client-side | `grep -n "statusOf" pages/index.js` |
| Bundle record shape + cleanup sweep | `grep -n "createBundleRecord\|getBundleMembers" lib/bundles.js`; `grep -n "bunnybundle" pages/api/cleanup.js` |
| Revoke = flag flip; cleanup = delete revoked/expired | `cat pages/api/revoke.js pages/api/cleanup.js` |
| No cron configured | `ls vercel.json` (should error: No such file) |
| No CI | `ls .github/workflows` (should not exist) |
| README cron wording | `grep -n cleanup README.md` |
