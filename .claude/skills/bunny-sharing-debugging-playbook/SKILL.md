---
name: bunny-sharing-debugging-playbook
description: >
  Symptom-to-cause triage for the Bunny Video Sharing app: thumbnails 403,
  embed iframe black/403, empty video grid, no email arriving (Resend or SMTP),
  magic-link/sign-in-link problems, /watch errors, "sign-in link expired" loops,
  Basic-Auth loops, KV errors, missing share records, bundle/listing-page
  ("view all your videos" link) problems, and build warnings. Load
  this when something is BROKEN and you need to find out why. Do NOT load for
  first-time setup (use bunny-sharing-env-and-setup), for running the
  measurement/probe scripts (bunny-sharing-diagnostics), for the history behind
  a decision (bunny-sharing-failure-archaeology), or for live-proving the email
  gate end to end (bunny-sharing-email-gate-campaign).
---

# Bunny Sharing — Debugging Playbook

Triage runbook for the Next.js app in this repo that shares private Bunny.net
Stream videos via time-limited, email-gated `/watch/<token>` links, with share
records in Upstash Redis (KV) and email via Resend (API) or SMTP fallback.

How to use: find your symptom in the master table, then jump to the surface
section for the discriminating experiment. All commands assume cwd = repo root.
Many need env vars loaded; do that first:

```bash
set -a; [ -f .env.local ] && . ./.env.local; [ -f .env ] && . ./.env; set +a
```

(Values containing spaces must be quoted in the env file for this to work. On
Vercel, read the values from the project's Environment Variables page instead.)

Jargon, once:
- **share token** — 32-hex-char id in `/watch/<token>`; KV key `bunnyshare:<token>` (lib/shares.js:13,26).
- **grant** — HMAC-signed proof of email control, `body.sig` in base64url, signed with `GATE_SECRET` (lib/gate.js). Emailed as `?grant=` (15 min TTL), then exchanged for a cookie.
- **gate cookie** — `gate_<token>`, HttpOnly, `Path=/watch/<token>`, lives until share expiry (pages/watch/[token].js:150-153).
- **two Bunny keys** — `BUNNY_TOKEN_KEY` signs iframe embed URLs (sha256 **hex**); `BUNNY_CDN_TOKEN_KEY` signs direct CDN URLs like thumbnails (sha256 **base64url**). Different keys, different encodings (lib/bunny.js:40-65).
- **bundle** — a `bunnybundle:<id>` KV record (lib/bundles.js) grouping one recipient's tokens from one `/api/share-bulk` call; gated at `/bundle/<id>` by the same grant mechanism, pseudo-token `bundle:<id>`. Purely a grouping list — a member's title/status always comes live from that member's own `bunnyshare:<token>` record, never from the bundle record itself.

## Master triage table

| Symptom | First check | Likely cause | Fix / section |
|---|---|---|---|
| Thumbnails broken images / 403 in admin grid | `curl -sI` one thumbnail URL | `BUNNY_CDN_TOKEN_KEY` missing or wrong (or it's the embed key by mistake) while pull-zone Token Authentication is ON | S1 |
| Thumbnails simply absent (no `<img>` URL at all) | Is `BUNNY_PULL_ZONE` set? | `BUNNY_PULL_ZONE` unset → `thumbnail: null` (lib/bunny.js:26-28) | S1 |
| Embed iframe black or 403 | Open the iframe `src` directly; compare its `expires` to `date +%s` | `BUNNY_TOKEN_KEY` wrong, or the page has been open > 1 h (embed URLs are signed for 3600 s at page render, pages/watch/[token].js:171) | S1 |
| Admin video grid empty, NO error shown | `curl` `/api/videos` yourself | API actually 500ing; the UI swallows errors (`vRes.videos \|\| []`, pages/index.js:31) | S1 |
| `/api/videos` returns 500 | Read the JSON `error` field | `BUNNY_API_KEY` / `BUNNY_LIBRARY_ID` wrong — Bunny's own error text is passed through (lib/bunny.js:16, pages/api/videos.js:9) | S1 |
| No share email arrives (share / bulk / magic link) | Which deliver() path is active? (`RESEND_API_KEY` set → API, else SMTP; lib/mailer.js:35). Check the shares table for a "⚠ email failed" badge first — the record already has the error. | Resend: domain/from/key problem. SMTP: port/TLS/auth. | S2 |
| Magic link never arrives though the email "matches" | Did the recipient get "Check your email" (200) or an error (500)? | Mismatch vs throttle vs delivery failure — run the 4-step sequence | S2 |
| Magic links stopped arriving mid-testing, nothing else changed | Have you requested >10 links in a minute from this machine? | Per-IP rate limit (`gateip:<ip>`, 10/min, added 2026-09-13). The response is UNCHANGED and no email sends — silent by design. Delete the key or wait 60 s | S2 |
| "That sign-in link has expired" right after a click that worked | Did they re-click the EMAIL, or reload the page? | Single-use magic links (added 2026-09-13) — re-clicking a spent link is expected | S3 |
| "This link has reached its view limit." | Does the record have `maxViews`? | The share's view cap is spent. Extend does not reset it | S5 |
| A share is missing from the admin table | Status filter / search / page number in the toolbar | Server-side filtering and paging (added 2026-09-13), not a data problem | S5 |
| First-play notification never arrives | Settings toggle ON *and* `ADMIN_NOTIFY_EMAIL` (or a from-address) resolving? | Both are required and the failure is silent and swallowed by design; also fires only ONCE per share, ever | S2 |
| Magic link never sends on a link that was bulk-shared to several people; all recipients got the SAME links | `record.email` in KV — does it contain commas/spaces? | Legacy combined-email record (pre-2026-07-19 comma-string bug; failure-archaeology Ep. 9). Gate now matches any listed address, so sign-in works — but the token is shared between those recipients; revoke + re-share for per-person links/tracking | S2 |
| Recipient submits email → error "GATE_SECRET is not set…" | — | `GATE_SECRET` unset in the runtime env (lib/gate.js:14-22); build passes without it, only requests fail | S3 |
| `/watch/<token>` returns 500 | Server logs / `curl` the page | KV unreachable or bad creds — `kvGet` throws inside `getServerSideProps` (lib/kv.js:13-15, pages/watch/[token].js:122) | S3, S5 |
| "That sign-in link has expired" on every click | Time between email and click; `GATE_SECRET` equality across environments | > 15 min elapsed, `GATE_SECRET` rotated/differs, server clock skew, or grant from a different share (token-bound) | S3 |
| Magic link click → silently back to the email form | Was the test over plain http with `SITE_URL=https://…`? | Cookie set with `Secure` but browsed over http → browser drops it (pages/watch/[token].js:146-153) | S3 |
| Cookie works on one share, not another for same viewer | — | By design: cookie is `Path=/watch/<token>`, scoped per share | S3 |
| Browser Basic-Auth prompt loops on `/` or admin APIs | Are `ADMIN_USER`/`ADMIN_PASS` set in the runtime env? | Unset or mismatched — unset can never match (middleware.js:9-18) | S4 |
| `/api/watch/request-link` or `/api/bundle/request-link` returns 401 | `git diff` middleware.js matcher | Matcher regressed; must be `"/api/((?!watch/\|bundle/).*)"` (middleware.js:31, widened 2026-07-20) | S4 |
| `KV error 401: …` (or other status) in errors/logs | `curl` KV directly | Bad `KV_REST_API_TOKEN` / wrong `KV_REST_API_URL` (lib/kv.js:14) | S5 |
| Share record missing / shares table empty though shares exist | `KEYS bunnyshare:*` vs `KEYS share:*` | Wrong KV database, or records under the pre-30ecd7f `share:` prefix (orphaned) | S5 |
| Build prints `⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.` | — | EXPECTED on next 16.2.10. Not an error. Do not rename without change-control. | S6 |
| `/bundle/<id>` shows "Link not found" right after a bulk share | `KEYS bunnybundle:*` in KV; confirm `share-bulk` actually returned a `bundleLink` in its response | Bundle creation failed silently, or you're pointed at a different KV database than the app used (see S5's `share:`/`bunnyshare:` divergence check — same trap applies to `bunnybundle:`) | S7 |
| Bundle magic link exchanges fine but individual videos still show the email form | Check the exchange response's `Set-Cookie` headers — should be ONE `gate_bundle_<id>` PLUS one `gate_<token>` per member in the SAME response | Cookies not applied by the client (multiple `Set-Cookie` headers dropped by a proxy/test tool that only keeps the last one — real browsers handle this fine); or a member's own `bunnyshare:<token>` record was already revoked/expired at exchange time, which correctly skips minting that one cookie (pages/bundle/[bundleId].js) | S7 |
| `/api/share/extend` returns `"Cannot extend a revoked share"` | `kv-inspect` the record's `revoked` field | Working as intended — extend deliberately refuses revoked records rather than doubling as an un-revoke (pages/api/share/extend.js, added 2026-07-21). There is no endpoint that un-revokes; that would need a new, separate action | S1-S7 (n/a) |
| Extended share's new `expiresAt` looks wrong (too soon/too far) | Was the share already expired at extend time? | Extend computes `Math.max(Date.now(), record.expiresAt) + hours*3600*1000` (pages/api/share/extend.js) — an ALREADY-EXPIRED share extends from now, not from its old (past) expiry; a NOT-YET-expired share extends from its current expiry. Confirm which branch applied before assuming a bug | S1-S7 (n/a) |
| Bulk revoke reports a "success" for a token you expected to already be revoked | Check the record's `revoked` field before AND after | Working as intended — `revokeOne` (pages/api/revoke.js, refactored 2026-07-21 for bulk) is idempotent by design: revoking an already-revoked record is a no-op success, not a failure, so a batch that happens to include one is never spuriously flagged | S1-S7 (n/a) |

## S1 — Playback and thumbnails

Three distinct signing/auth surfaces (all in lib/bunny.js):
- List videos: Bunny Stream API, `AccessKey: BUNNY_API_KEY` header (lib/bunny.js:10-13).
- Embed iframe: `generateEmbedUrl` → sha256 **hex** of `BUNNY_TOKEN_KEY + videoId + expires` (lib/bunny.js:56-65).
- Thumbnails: `signCdnUrl` → sha256 **base64url** (`+`→`-`, `/`→`_`, `=` stripped) of `BUNNY_CDN_TOKEN_KEY + pathname + expires` (lib/bunny.js:40-52). If `BUNNY_CDN_TOKEN_KEY` is unset the URL is returned unsigned (lib/bunny.js:42).

### Videos list empty or 500

The admin UI hides API errors (pages/index.js:31). Always curl the API:

```bash
curl -s -u "$ADMIN_USER:$ADMIN_PASS" "${SITE_URL:-http://localhost:3000}/api/videos" | head -c 400
```

Branches:
- `{"videos":[…]}` with items → API fine; UI/browser problem (check Basic Auth in browser, S4).
- `{"videos":[]}` → library genuinely empty, or wrong `BUNNY_LIBRARY_ID` pointing at an empty library.
- `{"error":"Bunny API error: 401 …"}` → `BUNNY_API_KEY` wrong. The status/text after "Bunny API error:" is Bunny's own response, passed straight through (lib/bunny.js:16 → pages/api/videos.js:9) — read it, it usually names the problem.
- `{"error":"Bunny API error: 404 …"}` → `BUNNY_LIBRARY_ID` wrong.

Bypass the app entirely to isolate creds:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "AccessKey: $BUNNY_API_KEY" \
  "https://video.bunnycdn.com/library/$BUNNY_LIBRARY_ID/videos?itemsPerPage=1"
# 200 = creds fine (problem is app-side env); 401 = key; 404 = library id
```

### Thumbnails 403 (incident 65dc992 — the two-keys trap)

Grab one thumbnail URL from `/api/videos` output, then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "<thumbnail-url>"
```

- `200` → thumbnails fine; a broken image in the browser is something else (mixed content, ad-blocker).
- `403` and the URL has **no** `?token=` → pull-zone Token Authentication is ON but `BUNNY_CDN_TOKEN_KEY` is unset (app returned URL unsigned, lib/bunny.js:42). Set it from Bunny: Library > API > "CDN zone management" > Manage > Security > Token Authentication (lib/bunny.js:36-39).
- `403` and the URL **has** `?token=…&expires=…` → key is wrong. The classic mistake is pasting the Embed View Token (`BUNNY_TOKEN_KEY`) here. Verify the signature reproduces:

```bash
node -e '
const c=require("crypto");
const u=new URL(process.argv[1]);
const exp=u.searchParams.get("expires");
let t=c.createHash("sha256").update(process.env.BUNNY_CDN_TOKEN_KEY+u.pathname+exp).digest("base64")
  .replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
console.log(t===u.searchParams.get("token")?"token matches key":"token does NOT match key");
' "<thumbnail-url>"
```

"matches" but still 403 → the key in your env differs from the key Bunny has (rotated), or `expires` already elapsed (signed for 3600 s, lib/bunny.js:40).
- `404` → wrong `BUNNY_PULL_ZONE` hostname.

### Embed iframe black / 403

The `/watch` page signs the embed URL for **3600 s at render time** (pages/watch/[token].js:171, lib/bunny.js:56). Get the iframe `src` (view page source or devtools) and:

```bash
date +%s   # compare with the expires= query param in the iframe src
```

- `expires` < now → tab was open > 1 h; a page refresh mints a fresh URL. Not a bug.
- `expires` in the future but 403/black → `BUNNY_TOKEN_KEY` wrong (must be the Stream library's Embed View Token, Library > API > Security — NOT the CDN key). Recompute (note: **hex**, not base64url):

```bash
node -e '
const c=require("crypto");
const u=new URL(process.argv[1]);
const videoId=u.pathname.split("/").pop(), exp=u.searchParams.get("expires");
const t=c.createHash("sha256").update(process.env.BUNNY_TOKEN_KEY+videoId+exp).digest("hex");
console.log(t===u.searchParams.get("token")?"token matches key":"token does NOT match key");
' "<iframe-src-url>"
```

- Also check the library id inside the URL path (`/embed/<lib>/<video>`) equals `BUNNY_LIBRARY_ID`, and that embed token authentication is actually enabled on the library (if it's off, Bunny ignores the token — things "work" until someone enables it).

## S2 — Email (nothing arrives)

**Step zero, always: determine which `deliver()` path is active.** lib/mailer.js:35 — if `RESEND_API_KEY` is set (in the RUNTIME env, not just some .env file), every email goes through the Resend HTTP API and all SMTP_* vars are ignored. Otherwise nodemailer SMTP.

```bash
[ -n "$RESEND_API_KEY" ] && echo "Resend API path" || echo "SMTP path"
```

The from address is `RESEND_FROM || SMTP_FROM || SMTP_USER` (lib/mailer.js:24-26) on both paths.

### Resend branch

Failures throw `Resend API error: <message>` (lib/mailer.js:39). What happens next depends on the endpoint (as of 2026-07-20): `/api/share` and `/api/share-bulk` catch each recipient's send failure individually — the KV record(s) still get created, flagged `emailFailed: true` with the error in `emailError` (lib/shares.js `setEmailFailed`), and reported in a `failures` array in the response (200 if at least one recipient succeeded, 500 only if ALL failed). The admin table shows a "⚠ email failed" badge (hover for the error) and a "Resend" button (every active row has one, not only flagged ones — it's a general "nudge the recipient" action) that hits `/api/share/resend`; select multiple rows for `/api/share/resend-bulk` — check there FIRST before re-triggering a whole new share. The magic-link path (`/api/watch/request-link`) is different: it has no record to flag (nothing new is created) and stays behind the uniform anti-enumeration response — see "Magic-link email specifically" below. Typical `emailError`/thrown messages:

- domain not verified (Resend 403) → verify the sending domain in the Resend dashboard, or use `onboarding@resend.dev` for tests.
- invalid `from` (Resend 422) → `RESEND_FROM` (or fallback) is not an address on a verified domain.
- invalid API key (401) → `RESEND_API_KEY` wrong/revoked.

Probe Resend directly, bypassing the app:

```bash
curl -s https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" -H "Content-Type: application/json" \
  -d "{\"from\":\"${RESEND_FROM}\",\"to\":[\"<your-test-inbox>\"],\"subject\":\"probe\",\"text\":\"probe\"}"
# {"id":"..."} = accepted; anything with "statusCode" = the exact failure
```

Accepted by Resend but not in the inbox → deliverability (spam folder, SPF/DKIM) — see email-delivery-reference. Check the Resend dashboard's Emails log for the delivery status.

### SMTP branch

The transporter sets `secure` **only** when `SMTP_PORT` is exactly 465 (lib/mailer.js:47). Port 587 uses STARTTLS (plain connect, then upgrade) — that is correct; do NOT "fix" it by forcing `secure: true` on 587, which hangs or fails the handshake. Conversely, port 465 with `secure: false` fails too; the code handles both as long as `SMTP_PORT` is accurate.

Probe with the exact same config the app builds:

```bash
node -e '
const n=require("nodemailer");
const t=n.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),
  secure:Number(process.env.SMTP_PORT)===465,
  auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});
t.verify().then(()=>console.log("SMTP OK: connection + auth accepted"))
 .catch(e=>console.error("SMTP FAIL:", e.message));'
```

Branches by failure text:
- `Invalid login` / `535` → `SMTP_USER`/`SMTP_PASS` (Gmail needs an app password; Resend-over-SMTP is `smtp.resend.com`, port 587, user `resend`, pass = API key — and requires `RESEND_API_KEY` UNSET or the API path hijacks it).
- `ECONNREFUSED` / timeout → host/port wrong or provider blocks the port.
- TLS/handshake errors → port/`secure` mismatch (see above).
- `SMTP OK` but no mail → provider accepted-then-dropped; check the provider's activity log and sender verification.

### Magic-link email specifically — the discriminating sequence

`/api/watch/request-link` deliberately returns the SAME generic 200 for invalid link, revoked/expired link, mismatched email, throttled, and success (pages/api/watch/request-link.js:20-48) — anti-enumeration invariant, do not "fix". A recipient whose email "matches" but gets nothing needs this sequence:

1. **What did the browser show?** An error message (500) → it got PAST match+throttle and the SEND failed; the message is the mailer error (request-link.js:57-62) — go to the Resend/SMTP branch above. "Check your email" (200) → continue.
2. **Is it actually a match?** Compare against the record, remembering matching is trim+lowercase only (lib/gate.js:32-34) — `Bob@x.com` matches `bob@x.com`, but `bob+tag@x.com` does not:
   ```bash
   curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" \
     "$KV_REST_API_URL/get/bunnyshare:<token>"
   # read .email in the JSON; also confirm revoked=false and expiresAt in the future
   ```
   Mismatch / revoked / expired → the uniform 200 hid it. That is by design; create a new share for the right address.
3. **Throttled?** One magic link per share per 30 s (`gatethrottle:<token>`, request-link.js:43-48):
   ```bash
   curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" \
     "$KV_REST_API_URL/get/gatethrottle:<token>"
   # {"result":"1"} = throttled right now → wait 30 s, retry; {"result":null} = not throttled
   ```
   Trap: the throttle key is set BEFORE the send (request-link.js:48 vs :57). If the send fails, an immediate retry silently no-ops with a 200 for up to 30 s.
4. **All clear but still nothing** → delivery failed upstream of the inbox: server logs (Vercel function logs) for the 500s from step 1's earlier attempts, provider dashboard, spam folder.

## S3 — Gate / watch page

Flow (pages/watch/[token].js getServerSideProps): load `bunnyshare:<token>` → invalid/revoked/expired page; `?grant=` present and valid → set `gate_<token>` cookie, redirect to clean URL; valid cookie → render iframe; else email form.

### `/watch/<token>` returns 500

`getServerSideProps` has no try/catch — a throwing `kvGet` (KV creds/URL wrong, lib/kv.js:13-15) 500s the whole page. Check server logs for `KV error …`, then go to S5.

Note on `GATE_SECRET`: unset, it does NOT 500 the page render — `verifyGrant` swallows the throw and returns null (lib/gate.js:47-65). It surfaces when the recipient SUBMITS the email form: `signGrant` throws (lib/gate.js:14-22) and request-link returns 500 with the literal message `GATE_SECRET is not set. Add a long random value to your environment to enable email-gated links.` — shown in the gate form. Fail-loud and runtime-only: `next build` succeeds without `GATE_SECRET` (verified 2026-07-18), so a deploy with it missing looks green until the first recipient tries to sign in. Fix: set it (`openssl rand -hex 32`) in the runtime env and redeploy.

### "That sign-in link has expired" every time

That notice means a `?grant=` was present but was not accepted. Since 2026-09-13 there are FIVE branches, and the first one is new — the notice is deliberately identical for all of them, so you cannot tell them apart from the page:

0. **Already used (added 2026-09-13, `5eb7245`).** Magic links are now single-use: the grant is marked spent at the cookie-setting exchange (`lib/singleUse.js`), and a spent grant takes this exact fall-through. This is BY DESIGN — a replay must look like a stale link, or the page becomes an oracle telling an interceptor the link was real. Recognize it by the sequence, not the message: the recipient clicked the emailed link, it worked, and then they clicked the SAME email link again (rather than reloading the page or using the bookmark). Their cookie is still valid, so tell them to open `/watch/<token>` directly. Confirm server-side if you must:
   ```bash
   # the marker, if present, is the sha256 of the grant string
   curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/get/gateused:<sha256-of-grant>"
   ```
   If EVERY first click now shows this notice, that is a real bug — something is spending grants on a path that does not set the cookie. Check that `markGrantSpent` appears only inside the `query.grant` branch of the two gate pages.
1. **Genuinely expired** — magic-link grants live 15 min (request-link.js:8, `MAGIC_LINK_TTL_MS`). Recipient clicked an old email. Expected; request a fresh link.
2. **`GATE_SECRET` differs between signer and verifier** — rotated between send and click, or different values across environments (preview vs production on Vercel). Every outstanding grant AND every existing `gate_<token>` cookie dies on rotation. Verify the deployed value is the one you think it is; a quick fingerprint without printing the secret:
   ```bash
   node -e 'const c=require("crypto");console.log(c.createHash("sha256").update(process.env.GATE_SECRET||"UNSET").digest("hex").slice(0,12))'
   ```
   Run wherever emails are sent from and wherever clicks land; fingerprints must match.
3. **Clock skew** — expiry check is `Date.now() > payload.x` (lib/gate.js:60); a server clock minutes fast eats into the 15-min window. Compare `date -u` on the box with real time.
4. **Wrong-token binding** — grants are bound to one share token (lib/gate.js:61). A grant URL pasted onto a different share's `/watch` path verifies as null. By design.

Local self-test that isolates the gate from email/KV entirely:

```bash
node --input-type=module -e '
import { signGrant, verifyGrant } from "./lib/gate.js";
const g = signGrant({ token: "t1", email: "a@b.c", expiresAt: Date.now()+60000 });
console.log("verify same token:", !!verifyGrant(g, { token: "t1" }));   // expect true
console.log("verify other token:", !!verifyGrant(g, { token: "t2" }));  // expect false
'
```

### Magic link click → cookie set → but back at the email form (loop)

The exchange sets the cookie then redirects to the clean URL (pages/watch/[token].js:140-154). If the redirect lands back on the email form, the browser dropped the cookie. Check the `Secure` logic (pages/watch/[token].js:146-149): the flag is added when `x-forwarded-proto` is https OR `SITE_URL` starts with https. So **testing over plain http://localhost with a production-style `SITE_URL=https://…` in your env sets `Secure` on an http response — the browser discards the cookie and you loop**. Fix for local testing: set `SITE_URL=http://localhost:3000` (SITE_URL is required — `baseUrl()` throws if it's unset at all, see failure-archaeology Episode 11 — so "unset it" is no longer an option, only "point it at the right URL"). In production behind https this never fires.

Also check devtools > Application > Cookies for `gate_<token>`: its Max-Age equals time until share expiry (line 145) — a share expiring in seconds yields a near-dead cookie.

### Cookie works on one share but not another

By design. The cookie is `Path=/watch/<token>` (pages/watch/[token].js:152): one grant per share, so revoking or expiring one share never affects another, and a browser holds independent cookies per share. Each new share requires its own email confirmation. Not a bug; do not widen the Path.

## S4 — Admin / auth

middleware.js applies HTTP Basic Auth with matcher `["/", "/api/((?!watch/|bundle/).*)"]`: `/` and all `/api/*` EXCEPT `/api/watch/*` and `/api/bundle/*`; `/watch/*` and `/bundle/*` pages are never matched.

### Browser Basic-Auth prompt loops

Since 2026-09-13 the check is a CONSTANT-TIME compare (`timingSafeEqualStr`, lib/safeCompare.js) rather than `===`, and there is an explicit `if (auth && user && pass)` guard. Behaviour on failure is unchanged: if either env var is **unset**, nobody matches, so every attempt 401s and the browser re-prompts forever. Same loop for a plain typo. Note middleware is now `async` — if it somehow fails to register (check `Proxy (Middleware)` in the build output) the symptom is the OPPOSITE of a loop: the admin surface becomes unauthenticated. Discriminate:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -u "$ADMIN_USER:$ADMIN_PASS" \
  "${SITE_URL:-http://localhost:3000}/api/shares"
# 200 → creds fine, the browser has stale cached credentials (try a private window)
# 401 → env values at the server differ from what you're sending (unset or mismatch)
```

On Vercel, confirm the vars exist for the environment you're hitting (production vs preview each have their own set).

### Recipient endpoints returning 401

`/api/watch/request-link` must be PUBLIC — recipients have no admin credentials. If it 401s, the matcher regressed. Verify the exact expression at middleware.js:31 is `"/api/((?!watch/).*)"` (negative lookahead excluding `api/watch/`), then probe unauthenticated:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "${SITE_URL:-http://localhost:3000}/api/watch/request-link" \
  -H 'Content-Type: application/json' -d '{"token":"probe","email":"probe@example.com"}'
# 200 (generic anti-enumeration response) = correct. 401 = matcher broken.
```

This is invariant territory: `/api/watch/*` and `/watch/*` stay public, everything else stays behind auth. Route any matcher change through bunny-sharing-change-control.

## S5 — KV (Upstash Redis)

lib/kv.js is a REST wrapper; any non-OK response throws `KV error <status>: <body>` (lib/kv.js:14). That error text bubbles into API 500 JSON and into `/watch` page 500s.

### `KV error 401/…`

```bash
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/get/probe-nonexistent"
# {"result":null}  → URL + token both fine
# {"error":"..."} / 401 → KV_REST_API_TOKEN wrong (or read-only token used for writes)
# DNS/connection failure → KV_REST_API_URL wrong
```

### Record missing / shares table empty though shares exist

```bash
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/keys/bunnyshare:*"
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/keys/share:*"
```

Branches:
- `bunnyshare:*` empty, `share:*` has keys → orphaned pre-30ecd7f records: commit 30ecd7f (2026-07-03) silently migrated the prefix `share:` → `bunnyshare:` with no data migration, stranding earlier records. Current code reads only `bunnyshare:` (lib/shares.js:26, pages/watch/[token].js:122, pages/api/shares.js:6). Those old links are dead; re-share, or copy records to the new prefix if they must revive.
- Both empty but you created shares recently → you are pointed at a DIFFERENT database than the app (local `.env.local` vs Vercel env often diverge). Compare `KV_REST_API_URL` in both places.
- Keys exist but shares table still empty in the UI → curl `/api/shares` with admin creds and read the error; also note a specific record vanishing after "Cleanup" is expected if it was revoked or expired (pages/api/cleanup.js:9-13).
- Revoked share still listed → correct: revoke is a flag flip, never a delete (pages/api/revoke.js:12-13); only Cleanup deletes.
- **A specific share is missing but others show (added 2026-09-13):** the table is now server-side FILTERED and PAGED. Check, in this order: (1) is a status filter active in the toolbar — a revoked or expired share is hidden under "Active"; (2) is there a search term; (3) are you on page 1 — the table is newest-first, 50 per page. The row-count line reads "N of M" whenever a filter is narrowing the result. This is the single most likely cause of "my share vanished" on a current build, and it is not a KV problem at all. Confirm with an unfiltered query: `curl -s -u "$ADMIN_USER:$ADMIN_PASS" "$SITE_URL/api/shares?page=1" | head -c 400`.
- **A share shows "Used up" (added 2026-09-13):** it hit its `maxViews` cap. Not a bug, and Extend will NOT revive it — Extend moves `expiresAt` only. Today the only way back is re-sharing (new token). See roadmap (p).

## S6 — Build / dev

`npm run build` on next 16.2.10 prints:

```
⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.
```

This is EXPECTED (reproduced 2026-07-18, build succeeds). It is a deprecation notice, not an error, and the route summary still shows `ƒ Proxy (Middleware)`. Do NOT "fix" it by renaming middleware.js → proxy.js in passing: the middleware carries the auth-boundary invariant (S4) and the rename is a behavior-affecting change that goes through bunny-sharing-change-control with the S4 public-endpoint probe as verification.

Also expected: build succeeds with ZERO env vars set (verified 2026-07-18) — every config failure in this playbook is runtime-only. A green build proves nothing about configuration.

## S7 — Bundle listing page (added 2026-07-20)

`pages/bundle/[bundleId].js` mirrors `pages/watch/[token].js`'s flow one
level up: load `bunnybundle:<id>` → invalid/expired page if missing or past
`expiresAt`; `?grant=` present and valid (bound to pseudo-token
`bundle:<id>`) → mint a `gate_bundle_<id>` cookie AND a `gate_<token>` cookie
for every member, redirect to the clean bundle URL; valid `gate_bundle_<id>`
cookie → re-fetch every member's own `bunnyshare:<token>` LIVE and render the
list (never trust a cached title/status on the bundle record itself — there
isn't one); else the email form, posting to `/api/bundle/request-link`.

Debugging is almost identical to S2/S3 above with a bundle-shaped id instead
of a token — reuse those sections' techniques (fingerprint `GATE_SECRET`,
check for `bundlethrottle:<id>` the same way as `gatethrottle:<token>`,
check `Secure`-on-http the same way) with these substitutions:

```bash
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/get/bunnybundle:<id>"
# .tokens should list every member token from that bulk-share call
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/get/bundlethrottle:<id>"
# {"result":"1"} = throttled (< 30 s since last magic-link send for this bundle)
```

One thing this page does that `/watch/[token].js` does not: it issues
MULTIPLE `Set-Cookie` headers in one response (the bundle cookie plus one
per member). If a test tool (some HTTP clients, some proxies) only surfaces
the last `Set-Cookie` header, that looks like "the exchange silently failed
to unlock the videos" when it didn't — real browsers apply every
`Set-Cookie` header in a response. Verify with a tool that shows all headers
(e.g. `curl -i` prints each one on its own line) before suspecting the code.

**"Why does this recipient's notification email include a video I didn't
just share?"** — not a bug (widened 2026-07-20). `findOrExtendBundle`
(lib/bundles.js) reuses a recipient's existing active bundle across BOTH
`/api/share` and `/api/share-bulk` calls instead of making a new one every
time, and the email content is always rebuilt from the bundle's FULL current
membership (`getBundleItems`), not just what this particular call created.
So sharing a second video to an address that already has one active share —
from either endpoint, in either order, any time before the first one
expires — produces ONE email listing both, with the same bundle link as
before, not a second standalone email. To confirm this is what happened
(not a mixed-up recipient): `curl` `bunnybundle:*` for that email
(`kv-inspect`, or `$KV_REST_API_URL/keys/bunnybundle:*` then `/get/` each)
and check `.tokens` — it should list every token that appeared in the email.
If the email content and the bundle's `tokens` don't match, THAT is a real
bug; if they match, this is the intended consolidation.

## Traps that cost real time

**The two Bunny keys.** Bunny has two unrelated token-auth schemes and this app uses both: `BUNNY_TOKEN_KEY` (the Stream library's Embed View Token) signs iframe embed URLs as sha256 hex, while `BUNNY_CDN_TOKEN_KEY` (the pull zone's Token Authentication key, buried under Library > API > "CDN zone management" > Manage > Security) signs direct CDN URLs like thumbnails as base64url with `+/=` rewritten (lib/bunny.js:40-65). Before commit 65dc992 (2026-07-14) the app only knew the first key, so enabling pull-zone Token Authentication made every thumbnail 403 while embeds kept working — a baffling half-broken state. If exactly one of {thumbnails, embeds} is 403ing, suspect the corresponding key before anything else, and never assume one key serves both.

**The verify()-per-send arc (7490382 → 30ecd7f).** Early mailer hardening (commits 7490382/4d9189f/1a2e4db, 2026-07-02) added env validation, `transporter.verify()` before every send, `requireTLS`, and emoji-decorated console logging of message IDs and accepted/rejected recipients. Commit 30ecd7f ("Fix", 2026-07-03) stripped all of it: verify-per-send doubled SMTP round-trips and produced its own failures, and the logs leaked recipient addresses. Today's mailer is deliberately minimal (lib/mailer.js:44-53). If email debugging tempts you to re-add per-send `verify()` or chatty logging, don't — run the standalone verify probe in S2 instead, which gives the same signal without touching production code.

**The prefix migration (30ecd7f).** The same "Fix" commit also renamed the KV key prefix `share:` → `bunnyshare:` with no migration, instantly orphaning every share created before it — live links died silently. This is the cautionary tale behind the repo's prime directive (never break live links) and the reason S5 tells you to check BOTH prefixes when a record has vanished. Any future change to key names, record fields, `/watch/<token>` URL shape, or the `gate_<token>` cookie must treat existing data as immovable.

**`secure` iff port 465.** `secure: Number(process.env.SMTP_PORT) === 465` (lib/mailer.js:47) looks like a bug to fresh eyes and gets "corrected" to `true`. It is right: 465 is implicit TLS from byte one; 587 must connect plain and upgrade via STARTTLS, which nodemailer does automatically when `secure: false`. Forcing `secure: true` on 587 stalls the handshake against a plaintext greeting; leaving it false on 465 fails the other way. The only knob that should change is `SMTP_PORT` itself, and the flag follows.

## When NOT to use this skill

- **Setting up from scratch** (fresh env, which vars to obtain where) → bunny-sharing-env-and-setup.
- **Running the packaged measurement/probe scripts** (KV inspect, gate self-test, email probe, etc.) → bunny-sharing-diagnostics; this playbook inlines minimal one-liners only.
- **Why the history went this way** (full incident chronicle, evidence, decisions) → bunny-sharing-failure-archaeology.
- **Live-proving the email gate end to end** against real Resend/Bunny/KV → bunny-sharing-email-gate-campaign.
- **Deciding whether a fix is safe to ship** → bunny-sharing-change-control.

## Provenance and maintenance

Written 2026-07-18 against branch `claude/bulk-share-separate-links-auth-cblrle` @ 5905bba; every cited line was read in that tree and the build warning + no-env build were reproduced the same day. S7 and the bundle-related table rows added 2026-07-20 alongside `lib/bundles.js`/`pages/bundle/[bundleId].js`/`pages/api/bundle/request-link.js`, verified live against a mock KV + mock SMTP. The consolidation callout ("why does this email include a video I didn't just share") added same day when `findOrExtendBundle` widened bundles to one-per-email. Extend and bulk-revoke rows added 2026-07-21. Re-verify before trusting drifted facts:

```bash
git log --oneline -1                                          # still near 5905bba (plus later commits)?
grep -n "RESEND_API_KEY" lib/mailer.js                        # deliver() path selection (~:35)
grep -n "465" lib/mailer.js                                   # secure-iff-465 (~:47)
grep -n "matcher" middleware.js                               # auth matcher (~:31) — expect (?!watch/|bundle/)
grep -n "MAGIC_LINK_TTL_MS\|THROTTLE_SECONDS" pages/api/watch/request-link.js   # 15 min / 30 s
grep -n "bunnyshare:\|gatethrottle:\|bunnybundle:\|bundlethrottle:" -r pages lib  # KV key prefixes
grep -n "generateEmbedUrl(record.videoId" pages/watch/[token].js  # 3600 s embed signing
grep -rn "digest(\"hex\")\|digest(\"base64\")" lib/bunny.js   # two encodings, two keys
npm run build 2>&1 | grep middleware                          # deprecation warning still expected?
```

If any grep comes back empty or on a different line, re-read that file before following this playbook's advice — the repo always wins over this document.
