---
name: bunny-sharing-email-gate-campaign
description: >
  The executable, decision-gated campaign to take the email-gated share-link
  system (built 2026-07-18, commits 7e2c016/5905bba) from "code-complete and
  crypto-certified" to "certified in production", then harden it. Numbered
  phases P0-P5 with exact commands, expected observations, and
  if-X-instead-branch-to-Y tables; a ranked hardening menu; fenced-off wrong
  paths. Load this when the task is to prove, certify, or harden the email
  gate or bulk sharing against live Resend/Bunny/KV — the project's
  designated hardest live problem. Do NOT load for routine gate debugging
  (bunny-sharing-debugging-playbook), for design rationale
  (bunny-sharing-architecture-contract), or for general evidence standards
  (bunny-sharing-validation-and-qa — this campaign feeds its certified
  inventory).
---

# Email-gate certification campaign

**State as of 2026-07-18:** the gate (type-email → magic-link → Path-scoped
cookie) and bulk sharing (N videos → N distinct tokens) are implemented and
build clean; the crypto layer is certified by self-test (9/9). NOTHING has
been exercised against live Resend, a real inbox, or production Bunny/KV.
This campaign closes that gap. Success is measurable at every gate — never
judged by eye. Log every observation (command + literal output) as you go;
the log IS the certification artifact.

Prerequisites: a Resend account with a verified domain (or another SMTP
provider), a Bunny Stream library with ≥3 videos, an Upstash Redis database,
an inbox you control. Jargon: "grant" = HMAC-signed authorization string from
lib/gate.js; "magic link" = `/watch/<token>?grant=<grant>` emailed after a
matching email is entered.

---

## P0 — Preflight (no network claims yet)

```bash
set -a; . ./.env.local; set +a
npm run build
node .claude/skills/bunny-sharing-diagnostics/scripts/gate-selftest.mjs
node .claude/skills/bunny-sharing-diagnostics/scripts/bunny-probe.mjs
node .claude/skills/bunny-sharing-diagnostics/scripts/kv-inspect.mjs
```

GATE P0 — expected: build lists all 10 routes (incl. `/api/watch/request-link`,
`/watch/[token]`) with only the middleware→proxy deprecation warning;
self-test 9/9; bunny-probe PASS with video count ≥1; kv-inspect connects
(0 records is fine).

| If instead | Branch |
| --- | --- |
| Build fails | Fix before anything else; bunny-sharing-debugging-playbook §build |
| Self-test <9/9 | STOP — gate.js broken; do not proceed |
| bunny-probe FAIL 401/404 | bunny-sharing-env-and-setup catalog (BUNNY_API_KEY/LIBRARY_ID) |
| kv-inspect MISSING ENV / 401 | Fix KV_REST_API_URL/TOKEN first |
| GATE_SECRET unset | Set it now (`openssl rand -hex 32`); everything in P1+ 500s without it |

## P1 — Local end-to-end with a real inbox

Start: `npm run dev` (http://localhost:3000; sign in with ADMIN_USER/PASS).
Create ONE share from the admin UI to an inbox you control, expiry 72 h.

Walk the flow and check each observation:

1. Share email arrives (seconds-to-low-minutes). Link shape:
   `<SITE_URL or http://localhost:3000>/watch/<32-hex>`.
2. Open the link → the email form renders (title visible), NOT the video.
3. Submit the CORRECT email. Expected response behind the UI (or via curl):
   HTTP 200, body exactly
   `{"ok":true,"message":"If that email matches this link, we've sent a sign-in link to it."}`
4. Magic-link email arrives. The link carries `?grant=<base64url>.<base64url>`.
5. Click it → video plays in the Bunny iframe AND the URL bar shows the clean
   `/watch/<token>` — the `?grant=` was stripped by redirect.
6. DevTools → Application → Cookies: cookie named `gate_<token>`, Path
   `/watch/<token>`, HttpOnly, SameSite=Lax. On localhost (http) the Secure
   flag is ABSENT — that is correct: the code adds `Secure` only when
   `x-forwarded-proto` is https or SITE_URL starts with https
   (pages/watch/[token].js). SITE_URL is REQUIRED (baseUrl() throws if
   unset — no Host-header fallback, see failure-archaeology Episode 11), so
   for local testing set it to `http://localhost:3000`, not an https URL —
   an https SITE_URL WILL set Secure and the cookie will be dropped on
   plain-http localhost.
7. Reload → plays without re-verification (cookie grant, valid until share
   expiry).

GATE P1 — all seven observed.

| If instead | Branch |
| --- | --- |
| No share email | `node .claude/skills/bunny-sharing-diagnostics/scripts/email-probe.mjs --to <you>` → its interpretation table; then debugging-playbook §email |
| 500 on /watch | GATE_SECRET missing in the dev process env |
| Step 3 returns 500 | Read the server console — request-link surfaces mailer/KV errors as `{error}` with status 500 |
| Magic-link email absent but response was the generic 200 | kv-inspect: is there a `gatethrottle:<token>` key (sent <30 s ago)? Is record.email exactly what you typed (compare normalized)? Then email-probe |
| Video iframe 403 | sign-check.mjs on the iframe src; bunny-stream-reference |
| Cookie absent after click | Secure-flag-on-http trap (observation 6); or grant expired (>15 min old email) — page shows the expiry notice and the email form again |

## P2 — Adversarial predictions (the security claims, each falsifiable)

Run with a live share token `<T>` from P1. Every prediction must be OBSERVED.

1. **Uniformity (anti-enumeration).** Wrong vs right email → byte-identical
   responses:
   ```bash
   curl -s -X POST localhost:3000/api/watch/request-link -H 'Content-Type: application/json' -d '{"token":"<T>","email":"right@you.com"}' > /tmp/r.json
   curl -s -X POST localhost:3000/api/watch/request-link -H 'Content-Type: application/json' -d '{"token":"<T>","email":"nobody@else.com"}' > /tmp/w.json
   diff /tmp/r.json /tmp/w.json && echo UNIFORM
   ```
   Expect `UNIFORM`. Also: nonexistent token → same body again.
2. **Tampered grant.** Take a real magic link, append `x` to the grant, open
   it. Expect: email form again with the notice "That sign-in link has
   expired. Enter your email to get a new one." (invalid and expired grants
   are deliberately indistinguishable). No cookie set, no video.
3. **Cross-share replay.** Grant for share A used on `/watch/<tokenB>?grant=…`
   → rejected (grants are token-bound; self-test case 3 is the unit-level
   proof; this is the integration check). Expect the email form, no cookie.
4. **Expired grant.** Craft one without waiting 15 minutes:
   ```bash
   node --input-type=module -e 'import {signGrant} from "./lib/gate.js"; console.log(signGrant({token:"<T>",email:"you@example.com",expiresAt:Date.now()-1000}))'
   ```
   Open `/watch/<T>?grant=<that>` → expiry notice + form.
5. **Revocation mid-flow.** Verify email, get cookie, confirm playback; revoke
   in admin UI; reload → "Access to this video has been revoked." (Record
   check happens before cookie check on every request — a valid cookie does
   not outlive revocation.)
6. **Throttle.** Two request-link POSTs with the correct email within 30 s:
   second returns the SAME generic 200 but sends NO second email (verify
   inbox count; kv-inspect shows the `gatethrottle:<T>` key while active).

GATE P2 — six of six observed and logged. Any deviation = a real security
regression: STOP, fix via bunny-sharing-change-control (these are its
security-sensitive class), re-run P2 from scratch.

## P3 — Bulk certification

1. Bulk-share 3 videos to your inbox. Expect ONE email listing 3 links.
2. Distinctness: save the 3 links to `links.txt`, then
   `grep -o 'watch/[a-f0-9]*' links.txt | sort | uniq -d` → must print nothing.
3. Verify email on link 1 → link 2 still shows its own email form (Path-scoped
   cookie does not leak).
4. Revoke share 2 → shares 1 and 3 still play; share 2 shows revoked page.
4a. Playback events (first live observation — Player.js compatibility of the
   Bunny embed is code-complete but UNVERIFIED live as of 2026-07-18): play a
   video, watch the Network tab for POSTs to `/api/watch/track` (expect
   `{"ok":true}` 200s on play and at 25/50/75% and on ended), then confirm
   the shares table's Watched column advances (`started` → `NN%` → `100% ✓`).
   If NO track calls appear at all → the embed's postMessage events aren't
   arriving; debug the Player.js handshake in the watch page's `Player`
   component before concluding anything else. Views column must increment
   regardless — the two trackers are independent.
4b. Multi-recipient: repeat with 2 videos × 2 recipients (both inboxes yours).
   Expect 2 emails, 4 distinct tokens total, each email containing only its
   recipient's links; recipient A's address fails the gate on B's links
   (uniform 200, no magic link — inbox check); watching one link sets its
   Views column to `1×` while the others stay `—` (per-person tracking).
5. kv-inspect: 3 records with distinct tokens, same email, same expiry.

GATE P3 — all five observed. Failure of #2 falsifies the feature's core claim:
STOP and treat as a release blocker.

## P4 — Production deploy and re-verification

Deploy (Vercel per bunny-sharing-run-and-operate) with production env vars
including https SITE_URL. Re-run: P1 steps 1–7 (now expect the `Secure` flag
PRESENT on the cookie — observation 6 inverts), P2 predictions 1, 2, and 6
against the deployed URL, and one bulk share (P3 steps 1–2).

GATE P4 — observed on the production domain over https.

## P5 — Certification bookkeeping

Through bunny-sharing-change-control (never silently): update
bunny-sharing-validation-and-qa's golden inventory — flip "email gate E2E",
"bulk E2E", and "email delivery" to CERTIFIED with the date and where the
observation log lives. The campaign is then complete.

---

## Hardening menu (post-certification, ranked; ALL are candidates gated by change-control)

1. **Single-use magic links. — BUILT 2026-09-13 (`5eb7245`), NOT YET
   CERTIFIED LIVE.** Implemented exactly as this menu specified:
   `gateused:<sha256(grant)>` via kvSetEx, TTL = grant remaining life,
   consumed ONLY on the cookie-setting exchange (the prefetcher mitigation
   this entry called for), in `lib/singleUse.js`, wired into both
   `pages/watch/[token].js` and `pages/bundle/[bundleId].js`. One decision
   beyond the spec: a spent grant falls through to the SAME expiry notice as
   a stale one rather than a distinct "already used" message, so a replay is
   indistinguishable from an expired link. Best-effort — KV errors fail open
   to the old replayable behaviour rather than locking out a valid holder.
   **Validation predicate still unmet:** opening the same magic link twice
   against a REAL deployment has not been observed; only unit tests
   (`tests/kvBacked.test.mjs`) and the checklist in validation-and-qa §2
   exist. Run that checklist during P3, and re-run the P2 uniformity suite —
   the spent-grant branch is new and must not have become distinguishable.
2. **Per-IP rate limiting. — BUILT 2026-09-13 (`5eb7245`), NOT YET CERTIFIED
   LIVE.** `lib/rateLimit.js`, `gateip:<ip>` counter with a 60s window, 10
   requests/min, reading the first `x-forwarded-for` entry as this entry
   advised. Applied to BOTH request-link endpoints and also to the new
   `/api/watch/request-access`. Placed before any `kvGet` so a spray costs
   one read. Over-limit returns the same `genericOk()` — verify this
   specifically in P2, since a rate-limit branch is the easiest place to
   accidentally introduce a distinguishable response or an obvious timing
   shortcut. **Validation predicate still unmet:** no live test of >N
   requests/min from one IP, and the non-atomic counter's behaviour under
   real concurrency is unmeasured.
3. **Cookie/grant lifetime tuning.** NOW THE TOP UNBUILT ITEM alongside 4.
   Note the new interaction: magic links became single-use in item 1, so
   shortening cookie life means more round-trips through a one-shot
   credential. Decide 1 and 3 together, not independently. Cookie currently lives until share
   expiry (up to caller-chosen hours); consider capping cookie Max-Age
   (e.g. 24 h) forcing periodic re-verification. Pure policy choice;
   validation: cookie expiry observed in devtools; UX cost acknowledged.
4. **Audit log of grant exchanges.** Append-only KV entries
   (`gatelog:<ts>`) on each exchange: token, hashed email, IP. Enables
   incident forensics. Validation: entries appear on each exchange; no PII
   beyond what records already hold.
5. **OTP fallback.** Previously considered and NOT chosen for v1 (see
   bunny-sharing-failure-archaeology — magic link won; OTP remains a valid
   alternative where corporate mail mangles links). Only pursue on real user
   reports of broken magic links.

## Fenced-off wrong paths (settled — do not re-fight)

- Do NOT reintroduce per-send `transporter.verify()` — removed in 30ecd7f for
  latency/failure-coupling; a one-off probe (email-probe.mjs) is the
  replacement (bunny-sharing-failure-archaeology).
- Do NOT switch to Auth0/Clerk — evaluated and rejected 2026-07-18
  (failure-archaeology); the HMAC gate is the accepted design.
- Do NOT "fix" statelessness by moving grants into KV wholesale — read the
  architecture-contract trade-off first (section 2.2 now documents the
  bounded exception explicitly). Item 1 shipped as that exception and is the
  ONLY licence: it stores a hash, only for emailed grants, only at the
  exchange, with a self-expiring TTL, and `verifyGrant` itself stayed pure.
  Widening any one of those properties is a new decision, not a continuation
  of this one.
- Do NOT relax response uniformity to give recipients "clearer errors" — the
  uniform 200 is a security invariant (change-control non-negotiable), not a
  UX bug.

## When NOT to use this skill

- A gate symptom outside a certification run → bunny-sharing-debugging-playbook.
- Why the gate is designed this way → bunny-sharing-architecture-contract.
- General evidence rules → bunny-sharing-validation-and-qa.

## Provenance and maintenance

Written 2026-07-18 against branch claude/bulk-share-separate-links-auth-cblrle
(commits 7e2c016, 5905bba). One-line re-verifications:

- Generic message string: `grep -n "sign-in link to it" pages/api/watch/request-link.js`
- TTL and throttle constants: `grep -n "MAGIC_LINK_TTL_MS\|THROTTLE_SECONDS" pages/api/watch/request-link.js` (15 min / 30 s)
- Secure-cookie condition: `grep -n "x-forwarded-proto" pages/watch/[token].js`
- Expiry-notice string: `grep -n "sign-in link has expired" pages/watch/[token].js`
- Crafted-grant one-liner still runs: see P2.4 (needs GATE_SECRET in env)
- Certification status: check bunny-sharing-validation-and-qa §3 — if already CERTIFIED with a date, this campaign has been run; only re-run after gate-surface changes.
- **The gate surface DID change on 2026-09-13 (`5eb7245`)**: single-use
  marking and per-IP limiting both touch the gate path. If this campaign was
  ever run before that date, its P2 (uniformity) and P3 (live flow) results
  are stale and must be re-run. As of that commit the campaign has NOT been
  run at all, so the gate remains uncertified either way.
- Single-use still wired? `grep -n "isGrantSpent" "pages/watch/[token].js" "pages/bundle/[bundleId].js"`
- Per-IP still wired? `grep -n "allowRequestFromIp" pages/api/watch/request-link.js pages/api/bundle/request-link.js pages/api/watch/request-access.js`
