---
name: bunny-sharing-env-and-setup
description: >
  Environment-variable catalog and from-scratch setup for the Bunny Video Sharing
  app. Load this when you need to know what an env var does, what breaks when one
  is missing or wrong, how config precedence works (Resend vs SMTP, from-address
  chain, SITE_URL fallback), how to bring the app up from a fresh clone, or when
  adding a NEW env var. Do NOT load this for day-to-day operation of an
  already-configured app (use bunny-sharing-run-and-operate), for diagnosing a
  live failure symptom (use bunny-sharing-debugging-playbook), or for Bunny API
  signing details (use bunny-stream-reference).
---

# Environment and Setup — Bunny Video Sharing

This app has no config files, no feature flags, no database migrations. **Its
entire configuration surface is 17 environment variables.** Every one is read
via `process.env` at request time (never at module top level, except `lib/kv.js`
which captures the two KV vars at import — same effect in practice, since server
env is fixed at process start). This skill catalogs all of them with exact
read sites and verified failure modes, then gives the from-scratch runbook.

Verified against the repo on 2026-07-18 (branch `claude/bulk-share-separate-links-auth-cblrle`, commit 5905bba).

Jargon, defined once:
- **Share record** — JSON stored in Upstash Redis at key `bunnyshare:<token>`; one per share link.
- **Magic link / grant** — HMAC-signed proof (signed with `GATE_SECRET`) that a recipient controls the email a share was sent to. See `lib/gate.js`.
- **Pull zone** — the Bunny CDN zone serving your Stream library's static assets (thumbnails etc.), e.g. `vz-xxxx.b-cdn.net`.

## 1. Env-var catalog

One row per variable. "Read in" cites the exact file and symbol. Failure modes
below were derived by reading each call path (file:line refs as of 2026-07-18).

| Var | Read in | Required? | Default / fallback | Failure mode when missing/wrong | Prod vs optional |
| --- | --- | --- | --- | --- | --- |
| `BUNNY_LIBRARY_ID` | `lib/bunny.js:7` (`listVideos`), `lib/bunny.js:58` (`generateEmbedUrl`) | Yes | none | Missing: `listVideos` fetches `.../library/undefined/videos` → Bunny API error → `/api/videos` returns 500 → admin grid empty. `generateEmbedUrl` silently builds `embed/undefined/<video>` → recipient player broken (no server error). | Required everywhere |
| `BUNNY_API_KEY` | `lib/bunny.js:8` (`listVideos`) | Yes | none | Missing/wrong: Bunny returns 401 → `listVideos` throws → `/api/videos` 500. Share/watch flows for existing records unaffected (they never call the Bunny API). | Required everywhere |
| `BUNNY_TOKEN_KEY` | `lib/bunny.js:57` (`generateEmbedUrl`) | Yes (if library Embed View Token Auth is on) | none — missing key is concatenated as the string `"undefined"` into the hash | No throw, no 500. The embed token is simply wrong; the Bunny iframe rejects it and the recipient sees the player's auth error. If the library's embed token auth is OFF, the bogus `?token=` is ignored and playback still works — a trap that hides misconfiguration until you enable token auth. | Required in prod (token auth should be on) |
| `BUNNY_PULL_ZONE` | `lib/bunny.js:20` (`listVideos`) | No | `thumbnail: null` when unset | Graceful: admin grid renders without thumbnail images (`pages/index.js:160` guards with `v.thumbnail &&`). Everything else works. | Optional |
| `BUNNY_CDN_TOKEN_KEY` | `lib/bunny.js:41` (`signCdnUrl`) | Only if pull-zone Token Authentication is ON | unset → `signCdnUrl` returns the URL unsigned (`lib/bunny.js:42`) | With pull-zone token auth ON and this unset: thumbnails 403 in the admin grid, but **embeds still play fine** (embeds use `BUNNY_TOKEN_KEY`, a different key). With token auth OFF: harmless either way. This exact confusion caused incident 65dc992 — see bunny-stream-reference. | Optional (conditional) |
| `SITE_URL` | `lib/shares.js` (`baseUrl`), `pages/watch/[token].js:148` (cookie `Secure` heuristic) | **Yes, as of 2026-07-22** | none — `baseUrl()` throws ("SITE_URL is not set…") if unset; there is NO Host-header fallback anymore (that fallback was itself the host-header-poisoning bug CodeQL flagged — see failure-archaeology Episode 11, not a fix for one) | Unset: every `baseUrl()` call throws. On the admin-only endpoints (`/api/share`, `/api/share-bulk`, `/api/share/resend[-bulk]`) this surfaces as a plain 500 to the (already-authenticated) admin. On the two PUBLIC gate endpoints (`/api/watch/request-link`, `/api/bundle/request-link`) the same throw is caught and returns the ordinary `genericOk()` 200 — indistinguishable from every other outcome, so a missing `SITE_URL` never becomes an anti-enumeration oracle, it just silently fails to deliver the magic-link email. Also feeds the cookie `Secure` flag when `x-forwarded-proto` is absent. Set it to `http://localhost:3000` in dev, your public https URL in prod. | Required everywhere |
| `ADMIN_USER` | `middleware.js:9` | Yes | none | Missing (either var): the string comparison at `middleware.js:18` can never succeed against `undefined` → **permanent 401 on `/` and all admin API routes** — total admin lockout. `/watch/*` and `/api/watch/*` stay reachable (outside the matcher). | Required everywhere |
| `ADMIN_PASS` | `middleware.js:10` | Yes | none | Same as `ADMIN_USER`. | Required everywhere |
| `GATE_SECRET` | `lib/gate.js:15` (`secret()`, called by `signGrant` and `verifyGrant`) | Yes at runtime | none — `secret()` **throws** ("GATE_SECRET is not set…"); deliberately no insecure default | Build unaffected: `next build` succeeds without it (read is call-time, `/watch` is SSR). Runtime, precisely: `/watch/<token>` does **not** 500 — `verifyGrant` wraps everything in try/catch (`lib/gate.js:47-65`), so the throw is swallowed and the page falls back to the email form. `POST /api/watch/request-link`/`request-link` for `/bundle` **with a matching email** hits the same throw via `signGrant`, but as of 2026-07-22 that's caught and returns the ordinary `genericOk()` 200, same as every other outcome — it no longer surfaces as a distinguishable 500 (that used to be a live anti-enumeration leak: a matching email was the ONLY path that threw, so a 500-vs-200 split would fingerprint valid token+email pairs; see failure-archaeology Episode 11). Net effect of either secret being unset: recipients can never get in, silently — check server logs (`console.error`), not the HTTP response, to diagnose this. | Required everywhere |
| `ADMIN_NOTIFY_EMAIL` | `lib/mailer.js` (`adminNotifyAddress()`), read by `/api/watch/track` (first-play) and `/api/watch/request-access` | No | falls back to `fromAddress()` — i.e. `RESEND_FROM` → `SMTP_FROM` → `SMTP_USER` | Added 2026-09-13 (`5eb7245`). Unset AND no from-address anywhere → `adminNotifyAddress()` returns undefined and both notifications are SKIPPED silently (each call site guards on it). Nothing 500s and no recipient-facing behaviour changes: first-play notification is swallowed on any failure by design, and `/api/watch/request-access` returns its uniform 200 regardless. **Trap:** this means "I enabled first-play notifications and got nothing" has two indistinguishable causes from the outside — the Settings toggle being off, or no notify address resolving. Check both, and check server logs. | Optional |
| `RESEND_API_KEY` | `lib/mailer.js:35-36` (`deliver`) | One email path required | unset → SMTP fallback path | Presence selects the Resend HTTP API path (SMTP vars then ignored). Wrong key: Resend returns an error → `deliver` throws → 500 from `/api/share`, `/api/share-bulk`, `/api/watch/request-link`. **Trap:** share/share-bulk store the record BEFORE emailing, so a failed send leaves a live record with no delivered email — since 2026-07-20 that record is FLAGGED (`emailFailed`) and surfaced in the admin table with a Resend button, rather than silently existing; a multi-recipient call reports `failures` instead of 500ing the whole batch. | Either this or SMTP set |
| `RESEND_FROM` | `lib/mailer.js:25` (`fromAddress`) | With Resend path: effectively yes | falls back to `SMTP_FROM`, then `SMTP_USER` | If the whole chain is empty, `from` is `undefined` → provider rejects → send throws → 500 (record already stored, as above). Resend also rejects senders not verified on your Resend domain. | Required when using Resend |
| `SMTP_HOST` | `lib/mailer.js:45` (`deliver`) | Required on SMTP path | none | Missing/wrong (with `RESEND_API_KEY` unset): nodemailer connection error → send throws → 500 on the three emailing routes; record already stored. | Required iff SMTP path |
| `SMTP_PORT` | `lib/mailer.js:46-47` | No | `587` (`Number(process.env.SMTP_PORT || 587)`) | `secure` is true **iff** the value is exactly `465` (implicit TLS); anything else, including the 587 default, uses STARTTLS. Wrong port → connection/TLS handshake failure → send throws → 500. | Optional (default 587) |
| `SMTP_USER` | `lib/mailer.js:49`; also third link in `fromAddress` chain (`lib/mailer.js:25`) | Required on SMTP path | none | Auth failure → send throws → 500. Note it doubles as the last-resort from-address. | Required iff SMTP path |
| `SMTP_PASS` | `lib/mailer.js:50` | Required on SMTP path | none | Auth failure → send throws → 500. | Required iff SMTP path |
| `SMTP_FROM` | `lib/mailer.js:25` (`fromAddress`) | No | falls back to `SMTP_USER` | Only cosmetic/deliverability: sets the From header on the SMTP path (and is the second fallback even on the Resend path). | Optional |
| `KV_REST_API_URL` | `lib/kv.js:6` (module const, used by `kvFetch`) | Yes | none | Missing: `fetch("undefined/get/…")` → URL-parse TypeError → **500 on every KV-touching surface**: `/api/share`, `/api/share-bulk`, `/api/shares`, `/api/revoke`, `/api/cleanup`, `/api/watch/request-link`, and `/watch/<token>` SSR (Next error page). Only `/api/videos` and the static admin shell survive. Read at module import — changing it requires a process restart. | Required everywhere |
| `KV_REST_API_TOKEN` | `lib/kv.js:7` | Yes | none | Missing/wrong: Upstash returns 401 → `kvFetch` throws `KV error 401` → same 500 blast radius as above. | Required everywhere |

Not in the catalog because they are not read anywhere: there are no other
`process.env` reads in `lib/`, `pages/`, or `middleware.js` (verified with the
grep in Provenance). `NODE_ENV` is handled by Next.js itself.

## 2. Config precedence rules (all of them — verified in code)

1. **Email path selection** (`lib/mailer.js:35`): `RESEND_API_KEY` set → Resend
   HTTP API; unset → nodemailer SMTP. Binary, presence-based. All SMTP vars are
   ignored when the Resend path is active (except as from-address fallbacks).
   Alternative: Resend-over-SMTP works too (host `smtp.resend.com`, port 587,
   user `resend`, pass = API key) — but only if you leave `RESEND_API_KEY`
   unset, otherwise the API path wins.
2. **From-address chain** (`lib/mailer.js:24-26`):
   `RESEND_FROM` → `SMTP_FROM` → `SMTP_USER` → `undefined` (send fails).
3. **Link base URL** (`lib/shares.js`): `SITE_URL`, always — `baseUrl()`
   throws if it's unset. There is no Host-header fallback (removed
   2026-07-22; the fallback WAS the host-header-poisoning bug, not a fix
   for one — see failure-archaeology Episode 11). Do not reintroduce one.
4. **SMTP port** (`lib/mailer.js:46-47`): default `587`; implicit TLS
   (`secure: true`) only when the port is exactly `465`.
5. **Share expiry hours** (`lib/shares.js:14`): request-body `hours`, falsy →
   `72` (`Number(hours) || 72` — so `0` also means 72).
6. **Cookie `Secure` flag** (`pages/watch/[token].js:146-149`):
   `x-forwarded-proto` header → else `https` iff `SITE_URL` starts with
   `https` → else `http` (no Secure flag).

## 3. From-scratch setup runbook

Assumes cwd = repo root, Node ~v22, npm available.

```bash
npm install
cp .env.example .env.local   # .env.local is git-ignored (.gitignore:26)
```

Fill `.env.local`. Where each value lives:

| Value | Where to get it |
| --- | --- |
| `BUNNY_LIBRARY_ID`, `BUNNY_API_KEY` | Bunny dashboard → Stream → your library → API. The API key is the library-level key sent as the `AccessKey` header. |
| `BUNNY_TOKEN_KEY` | Same library → API → Security: the **Embed View Token Authentication** key. |
| `BUNNY_PULL_ZONE` | The library's pull-zone hostname, e.g. `vz-xxxxxxxx-abc.b-cdn.net`. |
| `BUNNY_CDN_TOKEN_KEY` | Library → API → "CDN zone management" → Manage → Security → Token Authentication (per `.env.example:6-8` and the comment block at `lib/bunny.js:32-39`). Only if that toggle is ON. **Not the same key as `BUNNY_TOKEN_KEY`** — two keys, two signing schemes; see bunny-stream-reference. |
| `SITE_URL` | `http://localhost:3000` for dev; your public https URL in prod. |
| `ADMIN_USER` / `ADMIN_PASS` | Invent them; they are the Basic Auth credentials (plaintext compare in `middleware.js`). |
| `GATE_SECRET` | `openssl rand -hex 32` |
| `RESEND_API_KEY` / `RESEND_FROM` | resend.com → API Keys; `RESEND_FROM` must be a verified sender on your Resend domain. |
| `SMTP_*` | Only if not using Resend: any SMTP provider (Brevo, SMTP2GO, Gmail app password…). |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash console → your Redis DB → REST API section — or Vercel Storage tab ("Upstash for Redis"), which injects the same two names. |

Then:

```bash
npm run dev
# open http://localhost:3000 and sign in with ADMIN_USER / ADMIN_PASS
```

There is no test suite and no lint script — `dev`, `build`, `start` are the
only npm scripts (`package.json`).

### Minimal-viable subsets

- **Build only**: `npm run build` needs **zero** env vars (verified 2026-07-18:
  every read is call-time / SSR-time). Expect a deprecation warning about the
  `middleware` file convention — known, deliberate; do not rename
  `middleware.js` (see bunny-sharing-change-control).
- **UI smoke without real accounts** (`npm run dev` with only
  `ADMIN_USER`/`ADMIN_PASS` set):
  - Works: admin page loads after Basic Auth; layout renders.
  - Fails gracefully: no `BUNNY_PULL_ZONE` → no thumbnails; no
    `BUNNY_CDN_TOKEN_KEY` → unsigned thumbnail URLs.
  - Fails hard (500 JSON, page still up): `/api/videos` (no Bunny creds),
    `/api/shares` and every share action (no KV), `/watch/<anything>` (KV
    throw inside SSR → Next error page).
  - Omit `ADMIN_USER`/`ADMIN_PASS` and you get an unrecoverable 401 on `/`.
- **Full local run** needs: Bunny trio (+ pull zone vars for thumbnails), KV
  pair, `GATE_SECRET`, one email path, `SITE_URL=http://localhost:3000`.

## 4. Adding a new env var — checklist

The house style has exactly two failure-mode patterns; pick one deliberately:

- **Fail-loud** (secrets whose absence must never be silently defaulted):
  `GATE_SECRET` — `lib/gate.js:14-22` throws with an actionable message, no
  fallback. (Caveat to imitate better than the original: a swallowing
  try/catch downstream, like `verifyGrant`'s, can mute the loudness — decide
  where the throw surfaces.)
- **Graceful-degrade** (optional capability): `BUNNY_CDN_TOKEN_KEY` —
  `lib/bunny.js:41-42` returns the unsigned URL when unset, feature simply off.

Checklist:

1. Add the read site in code; read it inside the function (call-time), not at
   module top level, so builds stay env-free and tests/scripts can set it late.
2. Choose fail-loud vs graceful (above) and make the failure mode explicit.
3. Add the var to `.env.example` with a comment saying what it is, where to get
   it, and when it may be left blank (match the existing comment style).
4. Add a row to the README "Environment variables" table (`README.md:39-51`).
5. Add a row to the catalog in **this skill** (section 1), including the
   verified failure mode.
6. If deploying on Vercel: add it to each environment (Production / Preview /
   Development) in the dashboard — envs there are per-environment, not global.
7. Route the change through bunny-sharing-change-control (a new required var is
   a deploy-breaking class of change).

## 5. Known traps

- **`.env.local` is git-ignored** (`.gitignore:25-27`: `.env.local`,
  `.env.*.local`) — correct, but it means a fresh clone has no config at all
  and secrets must be re-provisioned per machine. Plain `.env` is NOT in
  `.gitignore`; use `.env.local`, never commit a `.env`.
- **Vercel**: env vars are set per-environment in the dashboard; a var added
  only to Production will be missing in Preview deploys and vice versa.
  Changing a var requires a redeploy to take effect.
- **`KV_REST_API_URL` trailing slash**: `lib/kv.js:10` builds URLs as
  `${KV_URL}${path}` where every path starts with `/` (e.g. `/get/<key>`). A
  trailing slash on the var yields double-slash URLs like
  `https://xxx.upstash.io//get/...`. Whether the server tolerates that is not
  something to bet on — paste the URL exactly as Upstash shows it, no trailing
  slash. Also note `KV_URL`/`KV_TOKEN` are captured at module import
  (`lib/kv.js:6-7`); a changed value needs a server restart.
- **The two Bunny keys**: `BUNNY_TOKEN_KEY` (embed URLs, sha256 **hex**) vs
  `BUNNY_CDN_TOKEN_KEY` (thumbnail/CDN URLs, sha256 **base64url**). Different
  keys, different dashboard locations, different encodings. Symptom split:
  thumbnails 403 but video plays → CDN key problem; video won't play but
  thumbnails fine → token key problem. Full signing math in
  bunny-stream-reference; the original incident is commit 65dc992.
- **`GATE_SECRET`/`SITE_URL` failures are quiet by design (as of 2026-07-22)**:
  a deploy missing either looks healthy — pages render, the email form
  shows, and `request-link` calls return the ordinary 200 even on a
  matching email — because their errors are now caught and folded into
  `genericOk()` rather than surfacing as a distinguishable 500 (this was a
  deliberate anti-enumeration fix; see failure-archaeology Episode 11).
  Don't rely on the watch page OR the request-link response to reveal
  either misconfiguration — check server logs (`console.error`) instead.
- **Email failures happen after the record is stored** (`pages/api/share.js`:
  `createShareRecord` before `sendShareEmail`; same order in share-bulk): a
  send-time env problem still creates live `bunnyshare:*` records.
- **`SITE_URL` is required**: unset, `baseUrl()` throws everywhere it's
  called (there's no fallback to fix by touching a heuristic anymore — see
  above). Set it to `http://localhost:3000` in dev.

## When NOT to use this skill

- Operating, deploying, or exercising an already-configured app (dev/prod
  workflow, cron cleanup, revocation, KV data conventions) →
  **bunny-sharing-run-and-operate**.
- Diagnosing a live failure from its symptom (403s, 500s, missing emails) →
  **bunny-sharing-debugging-playbook** (this skill only tells you what a
  *missing/wrong var* does; the playbook covers all causes).
- Bunny signing math and API details → **bunny-stream-reference**.
- Resend vs SMTP mechanics and deliverability → **email-delivery-reference**.

## Provenance and maintenance

All facts verified 2026-07-18 at commit 5905bba. Re-verify before trusting:

- Enumerate every env read (must match the catalog exactly):
  `grep -rhn "process\.env\.[A-Z_]*" lib pages middleware.js -o | sort -u`
- Documented vars: `grep -n "^[A-Z_]*=" .env.example` and the README table (`README.md:39-51`).
- Email path selection and from-chain: `grep -n "RESEND_API_KEY\|RESEND_FROM\|SMTP_" lib/mailer.js`
- SITE_URL required, no fallback: `grep -n "SITE_URL is not set\|req.headers.host" lib/shares.js` (throw present; no Host-header match)
- GATE_SECRET fail-loud + verifyGrant swallow: `sed -n '14,22p;47,66p' lib/gate.js`
- KV URL concatenation: `sed -n '6,17p' lib/kv.js`
- Ignore rules: `grep -n "env" .gitignore`
- Build-needs-no-env claim: `env -i PATH="$PATH" HOME="$HOME" npm run build` (expect success + middleware deprecation warning).
