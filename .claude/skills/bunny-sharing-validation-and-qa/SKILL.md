---
name: bunny-sharing-validation-and-qa
description: >
  Evidence standards for the bunny-sharing repo: the L0-L4 evidence ladder
  (build → gate self-test → live probes → manual E2E checklists → campaign
  certification), the checkbox E2E procedures for single share, bulk share,
  the bundle listing page, expiry, anti-enumeration, and the middleware auth
  boundary, the
  golden/certified inventory, and the automated `node --test` suite (added
  2026-09-13) with what it does and does not cover. Load this when you need to know WHAT COUNTS AS
  PROOF that a change works, before claiming anything "works", or when adding
  tests. Do NOT load this to pick a probe for a live failure
  (bunny-sharing-debugging-playbook), to run the probes themselves
  (bunny-sharing-diagnostics), or for the gate's live certification protocol
  (bunny-sharing-email-gate-campaign).
---

# bunny-sharing validation and QA

There IS an automated test suite as of 2026-09-13 (`5eb7245`): `npm test`
runs 50 `node --test` cases. There is still **no linter and no CI** — two
security-scanner workflows were tried and deleted (see
bunny-sharing-failure-archaeology), and nothing runs the suite automatically
on push, so running it is your job before every push.

The suite is **unit-level only**. It covers pure functions and helpers; it
does not touch a single API route, React component, or real service. So the
manual evidence discipline below has NOT been superseded — it has gained one
cheap rung underneath it. "It looks right" is still never evidence, and
"50 tests pass" is not evidence that a route works.

## 1. The evidence ladder

| Level | Evidence | Command / procedure | Proves |
| --- | --- | --- | --- |
| L0 | Production build passes | `npm run build` | Code compiles; routes register. Necessary, never sufficient. |
| L0.5 | Unit suite passes | `npm test` | The pure helpers behave: gate crypto, single-use marking, per-IP counting, Bunny pagination, watermark resolution, email parsing, share filtering/paging, analytics rollup, CSV escaping. |
| L1.5 | Route suite passes | `npm test` (the `tests/routes.*.test.mjs` files) | The API ROUTES behave against in-memory doubles for KV and Resend: uniform-response identity, per-IP enforcement actually stopping sends, access-request constraints, first-play notification firing exactly once, note/cap persistence and escaping, listing filters and paging, CSV export. Still no real service, and nothing inside a JSX page. |
| L1 | Gate self-test 9/9 | `node .claude/skills/bunny-sharing-diagnostics/scripts/gate-selftest.mjs` | lib/gate.js crypto contract holds. No network needed. |
| L2 | Targeted live probe | kv-inspect / bunny-probe / email-probe (bunny-sharing-diagnostics) with real creds | The specific integration (KV, Bunny, email) works against real services |
| L3 | Manual E2E checklist (below) | Deployed or dev instance, real accounts | The user-visible flow works end to end |
| L4 | Campaign certification | bunny-sharing-email-gate-campaign completed with logged observations | The gate's security claims hold live |

Required level by change class (classes defined in
bunny-sharing-change-control — that skill owns classification; this one owns
what each level means):

- Safe (docs/cosmetic): L0.
- Behavior-affecting: L0 + L0.5 + the L2/L3 items covering the touched surface.
- Compatibility-critical: L0 + L0.5 + L1 (if gate/token related) + the L3 backward-compat checks (old links still work).
- Security-sensitive: L0 + L0.5 + L1 + the relevant L4/P2 adversarial predictions.

L0.5 is now cheap enough to be non-negotiable: run it on every change, and
if you touched a pure helper, ADD a case rather than only running the
existing ones. It does not substitute for any higher level.

## 2. Manual E2E checklists

Run against `npm run dev` (http://localhost:3000) or a deployment. Each box
must be literally observed, not assumed.

### Single share
- [ ] Create share from admin UI (real recipient email you control).
- [ ] Share email arrives; link is `<site>/watch/<32-hex-token>`.
- [ ] Opening the link shows the email form (NOT the video).
- [ ] Submitting the matching email → "Check your email" page; magic-link email arrives.
- [ ] Clicking the magic link → video plays; URL bar shows the clean `/watch/<token>` (no `?grant=`).
- [ ] Reload → still plays (cookie grant).
- [ ] Revoke in admin UI → reload → "Access to this video has been revoked."

### Bulk share (the feature's core claims: separate links per recipient × video, per-person tracking)
- [ ] Select ≥2 videos, TWO recipients (comma-separated, both inboxes you control), send.
- [ ] EACH recipient gets ONE email listing only their own links (2 emails total; recipient A's links absent from B's email).
- [ ] Extract ALL links from both emails; assert all tokens DISTINCT — paste into a file and run `grep -o 'watch/[a-f0-9]*' links.txt | sort | uniq -d` (must print nothing). With 2×2 that's 4 distinct tokens.
- [ ] Each link gates independently (email verify on link 1 does not unlock link 2 — cookie is Path-scoped), and recipient A's email does NOT pass the gate on recipient B's link.
- [ ] Revoke ONE pair (e.g. recipient A × video 2) → A's other link and both of B's links still work.
- [ ] Comma-string regression guard: POST `/api/share-bulk` with legacy shape `{"videos":[...],"email":"a@b.c, d@e.f"}` and `/api/share` with `{"videoId":"...","email":"a@b.c, d@e.f"}` → each stored record's `email` field holds exactly ONE address (verify via kv-inspect), never the combined string.
- [ ] View tracking: watch one link → its shares-table row shows Views `1×` (hover shows last-viewed time); the unwatched rows show `—`. Reload the watch page → count increments.
- [ ] Playback tracking (needs a real Bunny video): press play → row's Watched column shows `started`; scrub past 25/50/75% → shows the milestone %; play to the end → `100% ✓`. Opening the page WITHOUT pressing play must leave Watched at `—` while Views increments — that separation is the feature's point.
- [ ] Email-failure handling (as of 2026-07-20): with SMTP/Resend deliberately broken, create a share → response is still 200 with a `failures` entry (single-recipient `/api/share` is the exception — one recipient, one failure, 500) and the record persists with `emailFailed: true`; the shares table shows "⚠ email failed"; click Resend after fixing creds → `emailFailed`/`emailError` disappear from the record (verify via kv-inspect, not just the UI).
- [ ] General resend, not just failure-recovery (added 2026-07-20): Resend works on a share that never had `emailFailed` set (no error shown, just re-sends). Select 3+ active rows via the checkboxes → "Resend N" bulk bar → `/api/share/resend-bulk` → response reports `succeeded`/`failures` per token; include one nonexistent or revoked token in the selection → that one reports a failure (`"Share not found"` or `"Share is revoked or expired"`) while the others still succeed.

### Bundle listing page (added 2026-07-20)
- [ ] Bulk-share ≥2 videos to one recipient → the `/api/share-bulk` response includes a `bundleLink`, and the recipient's email now also contains "view them all in one place" alongside the per-video links (both present — additive, not a replacement).
- [ ] Open the bundle link unauthenticated → the email form, NOT the list.
- [ ] Submit the matching email → magic link arrives; clicking it exchanges for cookies. Inspect the response headers directly (`curl -i`, not a tool that only shows the last `Set-Cookie`): ONE `gate_bundle_<id>` cookie AND one `gate_<token>` cookie per member, all in the same response.
- [ ] Reload the bundle page → lists all member videos as links, no re-verification needed (bundle cookie).
- [ ] Open one member's `/watch/<token>` URL directly (not by clicking from the list, to rule out any client-side state) → plays immediately, no email form — proves the per-video cookies minted by the bundle exchange are real, standard gate cookies.
- [ ] Revoke one member via `/api/revoke` → its `/watch/<token>` page shows "revoked" AND, on the SAME reload of the bundle page, that entry becomes non-clickable text `<title> — revoked` while other members stay live links. This is the no-second-source-of-truth check — the bundle record itself must NOT have been touched by the revoke, only the member's own `bunnyshare:` record.
- [ ] Anti-enumeration on the bundle gate: diff `/api/bundle/request-link` responses for right/wrong email and a nonexistent bundle id — must be byte-identical, same as the per-video gate.
- [ ] Tampered bundle grant (append a character) → falls back to the email form, not the list.
- [ ] `/api/cleanup` deletes a `bunnybundle:*` record once `Date.now() > expiresAt` (kv-inspect before/after).

### One bundle per email, not per call (added 2026-07-20)
- [ ] Single-share a video to a fresh recipient via `/api/share` → response has a `bundleLink`, email is the plain single-video email (not consolidated — this recipient has only one active share).
- [ ] Single-share a SECOND video to the SAME recipient via another `/api/share` call → response's `bundleLink` is IDENTICAL to the first call's; the email is now the consolidated multi-item email listing BOTH videos, not a second standalone email.
- [ ] Cross-endpoint: bulk-share one video to a fresh recipient, then single-share another video to that same recipient → same `bundleLink` both times; the second email lists both videos.
- [ ] Orphan sweep: manually write a `bunnyshare:<token>` record for an email with no bundle yet (kv-inspect / direct KV write), then share a new video to that email → the new bundle's `tokens` includes BOTH the pre-existing token and the new one, and the notification email lists both.
- [ ] A REVOKED or expired pre-existing record for that email must NOT be swept in — verify by revoking one first, then checking the fresh bundle only contains the still-active token(s).
- [ ] An unrelated third recipient sharing at any point in this sequence is unaffected: distinct bundle, plain single-video email (assuming it's their first).

### Extend a share's expiry (added 2026-07-21)
- [ ] Create a share with a short expiry, note `expiresAt` (kv-inspect). Extend it via the admin UI or `/api/share/extend` with `{token, hours}` while still Active → new `expiresAt` equals the OLD `expiresAt` plus `hours*3600*1000` exactly (not "plus hours from now").
- [ ] Create a share with an extremely short expiry (e.g. `hours: 0.001`), wait for it to actually pass, THEN extend it → new `expiresAt` lands at `Date.now()`-at-extend-time plus `hours*3600*1000`, not the old stale expiry plus the delta (the two would diverge for anything but a trivial `hours` value — assert against a `date +%s%3N`-style timestamp taken right before the call).
- [ ] Revoke a share, then try to extend it → `400 {"error":"Cannot extend a revoked share"}`, and `expiresAt` is unchanged (kv-inspect).
- [ ] Bulk extend 3 tokens where one is nonexistent and one is revoked → the valid one(s) succeed, the bad two report per-token failures (`"Share not found"` / `"Cannot extend a revoked share"`), response is still 200 overall.
- [ ] Extend a share that belongs to a bundle (bulk-share ≥2 videos first) → the bundle's own `expiresAt` (kv-inspect `bunnybundle:<id>`) is re-maxed to match, without touching the bundle's `tokens` list.
- [ ] Middleware boundary: `/api/share/extend` and `/api/share/extend-bulk` both 401 without admin creds.

### Bulk revoke (added 2026-07-21)
- [ ] Create 3 shares, bulk-select 2 of them via the checkboxes → "Revoke N" → both flip to `revoked: true` (kv-inspect), the third untouched.
- [ ] Include a nonexistent token in the bulk request → reported as a per-token `"Share not found"` failure without affecting the valid ones; response still 200 overall.
- [ ] Revoke the same token twice (two separate bulk or single calls) → the second call succeeds (idempotent), not an error.
- [ ] Single-token `/api/revoke` still behaves unchanged after the refactor: 200 on success, 404 for an unknown token.
- [ ] Middleware boundary: `/api/revoke-bulk` 401s without admin creds.

### Single-use magic links (added 2026-09-13)
- [ ] Complete the Single share flow above up to clicking the magic link; video plays.
- [ ] Open the SAME magic-link URL again (browser history / paste it fresh).
- [ ] It shows the email form with "That sign-in link has expired.", NOT the video.
- [ ] Critically: it looks IDENTICAL to what a genuinely expired link shows — diff the two pages if unsure. A distinguishable "already used" message is a bug (it tells an interceptor the link was real).
- [ ] The cookie from the first click still plays the video on reload — spending the grant must not log the legitimate viewer out.

### View limit (added 2026-09-13)
- [ ] Create a share with Max views = 1; complete the gate; video plays (view 1).
- [ ] Reload → "This link has reached its view limit."
- [ ] Admin table shows the row as "Used up" with `1× / 1`.
- [ ] Extend that share by some hours → it stays "Used up". Correct: Extend moves expiry, not the count. The two limits are independent.
- [ ] Click "+ Views" on that row, grant 2 → the row leaves "Used up" and reads `1× / 3`; the same link opens again with no new email and no new token.
- [ ] Confirm the view count did NOT reset — it still reads 1 used, not 0.
- [ ] Revoke a capped share, then try "+ Views" → refused, and the share stays revoked.
- [ ] A share with NO cap set is unaffected: open it several times, status stays Active.

### Access request on an expired link (added 2026-09-13)
- [ ] Let a share expire (or create one with a very short window).
- [ ] Open it → "This link has expired." AND a "Request more time" form.
- [ ] Submit the MATCHING address → confirmation text; `ADMIN_NOTIFY_EMAIL` receives an access-request email naming the video and token.
- [ ] Submit a NON-matching address on the same link → byte-identical confirmation text, and NO email arrives.
- [ ] Submit again within the hour → identical response, no second email (per-share throttle).
- [ ] REVOKE a share and open it → "revoked" message with NO request form (revocation is not appealable by design).

### Expiry
- [ ] Create a share with hours = a small fraction (e.g. 0.02 ≈ 72 s — `hours` is multiplied by 3600·1000; verify the record's expiresAt via kv-inspect).
- [ ] After expiry: `/watch/<token>` shows "This link has expired."; request-link on it returns the generic 200 but sends nothing.

### Anti-enumeration (uniform response)
The gate must not reveal which email a link belongs to. Diff the actual bytes:
```bash
curl -s -X POST localhost:3000/api/watch/request-link -H 'Content-Type: application/json' \
  -d '{"token":"<real-token>","email":"right@example.com"}' > /tmp/right.json
curl -s -X POST localhost:3000/api/watch/request-link -H 'Content-Type: application/json' \
  -d '{"token":"<real-token>","email":"wrong@example.com"}' > /tmp/wrong.json
diff /tmp/right.json /tmp/wrong.json && echo UNIFORM
```
- [ ] `UNIFORM` prints (bodies identical; both HTTP 200). Expected body (as of 2026-07-18): `{"ok":true,"message":"If that email matches this link, we've sent a sign-in link to it."}`

### Middleware auth boundary
```bash
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/api/shares            # expect 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/api/watch/request-link \
  -H 'Content-Type: application/json' -d '{}'                                  # expect 400 (NOT 401)
```
- [ ] Admin API 401s without credentials; recipient API is reachable without credentials.

## 3. Golden / certified inventory

As of 2026-07-18:

| Surface | Status | Evidence |
| --- | --- | --- |
| Gate crypto (lib/gate.js) | CERTIFIED | gate-selftest 9/9, run 2026-07-18 |
| Production build | CERTIFIED | `npm run build` clean (with expected middleware-deprecation warning) |
| Email-failure flagging + resend, incl. bulk (setEmailFailed, /api/share/resend, /api/share/resend-bulk) | CERTIFIED against mocks (L2/L3) | 2026-07-20: verified against a throwaway mock Upstash-REST KV + mock SMTP listener — flag set on failure, persists past reload, cleared on successful resend, bulk per-recipient isolation confirmed. Resend also verified as a general action (works with no prior failure) and bulk resend verified with a mixed valid/invalid/revoked token selection. NOT yet tried against real Resend failures specifically |
| Bundle listing page (lib/bundles.js, /bundle/[bundleId], /api/bundle/request-link) | CERTIFIED against mocks (L2/L3) | 2026-07-20: verified against the same mock KV + mock SMTP — bundle creation, email-gate exchange, multi-cookie minting, live status propagation on revoke (no second source of truth), anti-enumeration uniformity, tampered-grant rejection, and cleanup sweep all observed. NOT yet exercised in production (real https, Secure-cookie flag) |
| One-bundle-per-email consolidation (findOrExtendBundle, getBundleItems — both share.js and share-bulk.js) | CERTIFIED against mocks (L2/L3) | 2026-07-20 (same day, follow-up): two separate single-share calls to the same address consolidated into one email with a stable bundle link; cross-endpoint (bulk then single) consolidation confirmed; orphan sweep folded in a manually-injected pre-existing record; a revoked orphan was correctly excluded; an unrelated recipient was unaffected. NOT yet tried at scale (many bundles/shares) or against real Resend |
| Expiry extend, incl. bulk + bundle propagation (extendOne, extendBundleForToken — /api/share/extend, /api/share/extend-bulk) | CERTIFIED against mocks (L2/L3) | 2026-07-21: extending a not-yet-expired share added exactly the requested hours to its OLD expiry; extending an already-expired share correctly extended from now, not the stale expiry; a revoked share was correctly rejected with expiresAt unchanged; bulk extend with a mix of valid/nonexistent/revoked tokens reported per-token results without failing the batch; extending one bundle member correctly re-maxed the bundle's own expiresAt. Middleware boundary re-checked (both routes 401 without admin creds). NOT yet tried at scale or in production |
| Bulk revoke, incl. idempotency (revokeOne — /api/revoke-bulk) | CERTIFIED against mocks (L2/L3) | 2026-07-21: bulk-revoked 2 of 3 shares plus 1 nonexistent token in one call → both flipped, third untouched, bogus one reported a clean failure; re-revoking an already-revoked token succeeded (idempotent, not an error); single-token /api/revoke's behavior confirmed unchanged post-refactor. Middleware boundary re-checked (401 without admin creds). NOT yet tried at scale or in production |
| Grant-exchange audit log (`lib/gateLog.js`, `/api/gate-log`) | L0 + L0.5 | 10 cases: no plaintext address anywhere in the store, same-millisecond entries both survive, newest-first ordering, limit clamping, expired entries swept from the index, a store failure not throwing, and the endpoint neither leaking addresses nor accepting non-GET. No live pass — "entries appear on each exchange" is unproven against a deployment |
| Raising a view cap (`/api/share/allow-views`, +bulk) | L0 + L0.5 + L1.5 | 10 cases including the full round trip — a used-up share refused by `decideWatchAccess`, cap raised, SAME token passing the gate again — plus view-count preservation and both refusals. No live pass |
| The 2026-09-13 batch (`5eb7245`), API-route half: per-IP limiting, access requests, first-play notification, notes, view-cap persistence, shares filtering/paging, CSV export, server-side analytics | L0 + L0.5 + L1.5 | Build clean, all routes registered, 83/83 tests. Routes exercised directly against in-memory KV + Resend doubles, including byte-identity across all six uniform branches on both public endpoints — the first time invariant 4 has been checked by anything other than a grep count. Still no real service and no deploy |
| The WATCH page access decision: refusals, the single-use grant exchange and replay, `maxViews` at render, geo refusal, cookie shape, legacy-record compatibility | L0 + L0.5 | Extracted to `lib/watchAccess.js` on 2026-09-13 (roadmap item (r)) and covered by 19 cases in `tests/watchAccess.test.mjs`, including the replay being byte-identical to an invalid grant and a record carrying ONLY the original 2026-07 fields still gating/exchanging/playing. Still no live pass |
| The BUNDLE page access decision: its grant exchange, the N per-video cookies it mints, and live member status | L0 + L0.5 | Extracted to `lib/bundleAccess.js` on 2026-09-13 and covered by 17 cases, including that each minted per-video cookie verifies on its own share and not a sibling, is byte-identical to what the watch gate mints, and that a dead member is skipped rather than breaking the exchange. Still no live pass |
| Constant-time admin compare (`5eb7245`) | L0 + L0.5 | `tests/safeCompare.test.mjs` covers correctness. The TIMING property is argued from construction and has never been measured on Edge — do not claim it as verified |
| Everything else live (real email delivery, gate E2E, bulk E2E, Bunny playback) | UNCERTIFIED | Never exercised against real services — bunny-sharing-email-gate-campaign is the path to certification |

Update this table (via change-control) whenever a campaign phase or E2E
checklist upgrades a surface.

## 4. The automated test suite — SHIPPED 2026-09-13 (`5eb7245`)

`npm test` → `node --import ./tests/register.mjs --test tests/*.test.mjs`.
Zero new dependencies (Node's built-in runner), matching the repo's
observed convention of avoiding new deps.

| File | Covers |
| --- | --- |
| `tests/gate.test.mjs` | Sign/verify round-trip, expiry, token binding, signature AND payload tampering, malformed input never throwing, bundle-vs-video token separation, `grantFingerprint` properties, `normalizeEmail` |
| `tests/kvBacked.test.mjs` | Single-use marking and per-IP limiting against an in-memory stand-in for the Upstash REST API — spend-once, cross-grant isolation, TTL, raw grant never stored, per-IP cap and bucket isolation, and every fail-open path |
| `tests/bunny.test.mjs` | Pagination against a stubbed Bunny API: 250 items in 3 requests, 42 in 1, no loop past an exactly-full page, collections, and that an API error throws rather than returning a short list |
| `tests/settings.test.mjs` | The full watermark resolution order, including that an absent per-video key means inherit, not off |
| `tests/shares.test.mjs` | `parseEmails` fan-out across every separator, dedupe, `normalizeNote`, and `baseUrl`'s `SITE_URL` fail-loud with no Host fallback |
| `tests/shareQuery.test.mjs` | Status derivation (revoked beats expired; the `maxViews` exhausted case), filters, paging clamps, analytics rollup |
| `tests/csv.test.mjs` | Quoting, escaping, and formula-injection neutralization |
| `tests/helpers/harness.mjs` | The route harness: one `globalThis.fetch` router standing in for BOTH the Upstash REST API and the Resend HTTP API (both are plain fetch clients, so no module mocking and no new dependency), plus Next-style `req`/`res` doubles and a `fingerprint()` used to byte-compare uniform responses |
| `tests/routes.gate.test.mjs` | `/api/watch/request-link`: all six outcome branches byte-identical, only a matching address sends, the per-share throttle, the per-IP cap stopping sends at 10/min with bucket isolation, and the minted grant's token-binding, TTL and SITE_URL-derived link |
| `tests/routes.requestAccess.test.mjs` | `/api/watch/request-access`: expired-only and match-only sending, revoked never appealable, the hourly throttle, uniform responses across every branch, and that extra body fields (a `message`/`note`) never reach the admin's inbox |
| `tests/routes.track.test.mjs` | `/api/watch/track`: first play notifies exactly once ever, the toggle gates it, a mailer failure never fails the call, counters cannot be inflated without a valid token-bound grant, revoked/expired shares reject, progress is monotonic |
| `tests/routes.shares.test.mjs` | `/api/share` (note and cap persistence, absent-when-omitted, bad caps refused, HTML escaping, failed-send flagging), `/api/shares` (status filters incl. exhausted, search, paging and clamping, both totals), `/api/shares/export` (unpaged, filtered, formula neutralization, headers), `/api/analytics` (counts every share, not one page) |

**The resolver hook.** The app's source uses extensionless relative imports
(`from "./kv"`), which Next's bundler resolves and plain Node ESM does not.
`tests/resolve-hook.mjs` (registered by `tests/register.mjs`) retries a
failed relative resolution with `.js`. Nothing shipped depends on it. If
anyone later adds `"type": "module"` or rewrites the imports, DELETE the
hook rather than keeping two mechanisms.

**What it deliberately does not cover.** The remaining blind spot is
specific and worth stating exactly: **anything inside a JSX file.** Plain
Node cannot parse JSX and this repo has no transform available (only
`@swc/helpers`, a runtime shim, is installed). So these are untested:

- every React component, including the Analytics panel whose near-miss is
  recorded in failure-archaeology Episode 12, and the `Player` component's
  postMessage tracking;
- the thin glue left in each `getServerSideProps` — gathering facts and
  applying effects. Both access DECISIONS were extracted on 2026-09-13
  (`lib/watchAccess.js`, `lib/bundleAccess.js`) and are now tested.

That was ALSO true of both access decisions until 2026-09-13, when roadmap
item (r) extracted them into `lib/`. The remaining untested surface is
presentational. If you find yourself putting a decision into a page, put it
in `lib/` instead — that is the lesson item (r) bought.

Next rung, in priority order:
1. **Component-level tests**, which would need a JSX transform and therefore
   a new dependency — weigh that against this repo's no-new-deps convention
   before proposing it. The Analytics near-miss is the case for; the
   dependency is the case against.
2. **CI**, so any of this runs without being remembered. Note the history
   before proposing a scanner specifically (failure-archaeology Episode 5).
3. **A real-service pass** — the L2/L3/L4 rungs. Unchanged in priority by
   any of the above; doubles are not services.

**A caution learned building this suite (2026-09-13).** One crypto test
passed for the wrong reason: it "tampered" with a signature by flipping its
last base64url character. A 32-byte HMAC encodes to 43 characters whose last
carries only 4 significant bits, so several distinct final characters decode
to identical bytes — the tamper was frequently a no-op, and the test failed
only when a run happened to produce a signature ending in `A`. It was caught
by running the whole suite rather than the one file. Tamper at the BYTE
level (decode, flip, re-encode) and assert the bytes actually changed; a
green crypto test proves nothing if the mutation it applies is not real.

Keep `gate-selftest.mjs` regardless — it runs with no test infrastructure at
all and is referenced by change-control's pre-push protocol.

## 5. Acceptance discipline

- A claim of "X works" must name its evidence level and show the observation
  (command + output), not a summary of intent.
- Claims about *uniformity* (anti-enumeration) and *distinctness* (bulk links)
  are only provable by diffing actual outputs — the commands above.
- A change that cannot be evidenced at its required level does not ship; it
  stays a labeled candidate.

## When NOT to use this skill

- Diagnosing a live failure → bunny-sharing-debugging-playbook.
- Running the measurement scripts → bunny-sharing-diagnostics.
- The gate's full live certification → bunny-sharing-email-gate-campaign.
- Classifying a change → bunny-sharing-change-control.

## Provenance and maintenance

Verified 2026-07-18 on branch claude/bulk-share-separate-links-auth-cblrle;
email-failure and bundle sections added 2026-07-20, expiry-extend and
bulk-revoke sections added 2026-07-21 — all verified live against a mock KV
+ mock SMTP (not real Resend/Upstash — see the golden inventory table's
caveats for each). Updated 2026-09-13 for `5eb7245`: the no-tests premise
was false as of that commit, the ladder gained L0.5, section 4 became a
record of what shipped plus a ranked next rung, and the batch was added to
the golden inventory at L0+L0.5 ONLY.

- Tests present, CI still absent: `npm test` (expect 139+ passing);
  `ls .github 2>&1` (expect: No such file).
- Generic message string: `grep -n "sign-in link to it" pages/api/watch/request-link.js`.
- 401 boundary: `grep -n "matcher" middleware.js` (expect `/api/((?!watch/|bundle/).*)`).
- Hours→ms math: `grep -n "3600 \* 1000" lib/shares.js`.
- Extend math: `grep -n "Math.max(Date.now()" pages/api/share/extend.js`.
- Bundle record shape: `grep -n "createBundleRecord\|getBundleMembers" lib/bundles.js`.
- Golden inventory freshness: re-run gate-selftest and `npm run build` before trusting the table.
