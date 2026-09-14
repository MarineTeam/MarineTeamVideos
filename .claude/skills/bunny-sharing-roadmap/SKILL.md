---
name: bunny-sharing-roadmap
description: >
  The forward-looking register for the bunny-sharing repo: the idea lifecycle
  (proposal → evidence plan → compatibility-safe implementation → certification
  → adoption or documented retirement), the open-problems list with file-level
  first steps and falsifiable "you have a result when" milestones (sorted
  share index, audit log, cookie lifetime, view-cap administration, the
  unbuilt half of the admin auth upgrade) plus the adopted-outcome record
  for everything already shipped, and honest positioning of what here is standard
  practice vs genuinely nice design. Load this when proposing new work,
  prioritizing improvements, or asking "what should be built next". Do NOT
  load for executing the current gate certification
  (bunny-sharing-email-gate-campaign), understanding the current design
  (bunny-sharing-architecture-contract), or checking whether an idea was
  already tried and rejected (bunny-sharing-failure-archaeology — check it
  BEFORE proposing anything from here).
---

# bunny-sharing roadmap

Scope honesty first: this is a small production utility for sharing private
Bunny Stream videos, not a research project. "Advancing" it means operational
excellence and security posture — nothing here is novel computer science, and
no claim of novelty should ever be made. The value of this register is that
each entry names exact files, first steps, and a falsifiable finish line, so
a zero-context session can pick one up and know when it is actually done.

## 1. The idea lifecycle

1. **Check history.** bunny-sharing-failure-archaeology — if it was tried and
   rejected (Auth0/Clerk, per-send SMTP verify, OTP-first), do not re-open
   without new facts.
2. **Classify.** bunny-sharing-change-control assigns the class and its
   verification bar.
3. **State the prediction BEFORE coding.** Write down the measurable outcome
   ("after this change, X command outputs Y"). No prediction, no
   implementation.
4. **Implement inside compatibility.** The never-break-live-links rule:
   existing tokens, `bunnyshare:*` records, `/watch` URLs, and `gate_<token>`
   cookies keep working. New key namespaces are fine; renaming old ones is
   not.
5. **Certify** at the evidence level the class demands
   (bunny-sharing-validation-and-qa), then adopt — or record the retirement
   and why in failure-archaeology so the next session doesn't re-fight it.

Worked historical example (the email gate itself, 2026-07-18): requirement
("links must be tied to recipient email") → provider evaluation → Auth0/Clerk
rejected with reasons → HMAC magic-link design chosen → crypto self-test
written and passed BEFORE live claims → live certification deliberately left
open and tracked as the campaign. That full arc is the template.

## 2. Open-problems register

Each entry: why insufficient / the asset we have / first three steps in this
repo / "you have a result when…". All are CANDIDATES — none is scheduled work.

### (a) Replace KEYS scans (lib/kv.js) — ADOPTED 2026-07-22
- **Was:** `kvKeys("bunnyshare:*")`/`kvKeys("bunnybundle:*")` used Redis
  KEYS — O(N) over the WHOLE keyspace, not just this app's keys — on every
  admin page load, every `/api/share`/`/api/share-bulk` call (via
  `findOrExtendBundle`'s orphan sweep), every bundle-link lookup, every
  extend-a-share call (via `extendBundleForToken`), and every cleanup run.
  Prompted directly by a user question: "how many upstash commands would
  1000 shares be when loading shares page" — answer was ~1,002+B (1 KEYS +
  1000 GETs + 1 KEYS + B bundle GETs), which made the O(N) cost concrete
  enough to fix on the spot.
- **What shipped:** two new Redis SETs, `bunnyshare-index`
  (`lib/shares.js`) and `bunnybundle-index` (`lib/bundles.js`), exported as
  constants so every call site shares the same key. New `kvSadd`/`kvSrem`/
  `kvSmembers` helpers in `lib/kv.js`. `createShareRecord` and
  `createBundleRecord` SADD the new token/id into the index — wrapped in
  try/catch, deliberately best-effort: an index-write failure logs
  server-side but never blocks share/bundle creation, which has already
  succeeded by that point (worst case is a temporarily-invisible-in-admin
  share, never a broken link — the never-break-live-links rule is about
  links, and `/watch/<token>`/`/bundle/<id>` never read the index at all,
  only `kvGet` the record directly). EVERY KEYS-scanning call site was
  converted to SMEMBERS + per-key GET: `pages/api/shares.js`,
  `pages/api/cleanup.js` (both indexes, plus SREM on every deleted
  record), `pages/api/revoke-permanent.js` (SREM on delete), and three
  functions in `lib/bundles.js` — `findOrExtendBundle` (its orphan sweep
  over `bunnyshare:*`, the hottest of all these paths since it runs on
  every single share/bulk-share call, not just page loads),
  `bundleLinksForTokens`, and `extendBundleForToken`. `pages/api/cleanup.js`
  also now self-heals: any index entry whose record is already gone (e.g.
  from an interrupted delete elsewhere) gets SREM'd during the same run,
  without being miscounted as a real deletion.
  New one-time migration endpoint `pages/api/backfill-index.js` — the ONE
  remaining place that still does a real KEYS scan, on purpose, to seed
  both indexes from records that existed before the index did (idempotent:
  SADD naturally dedupes, safe to re-run). Surfaced in the admin UI next to
  Cleanup as "🔁 Rebuild index". Required once after upgrading an existing
  deployment with pre-existing records; a no-op on a fresh one.
- **Verified:** L0 (`npm run build` clean, `/api/backfill-index`
  registered) + a live L2/L3 pass against a mock Upstash REST server (not
  committed, throwaway): created 3 shares via `/api/share` → all 3 appeared
  in `/api/shares` via the new SMEMBERS-based listing, each with a correct
  per-recipient bundle link; permanently deleted one → confirmed its token
  was SREM'd from `bunnyshare-index` and it dropped out of the listing;
  injected a raw `bunnyshare:<token>` record directly into the mock store
  (bypassing SADD, simulating a pre-existing record from before this
  change) → confirmed it was invisible to `/api/shares` until
  `/api/backfill-index` was run, then present, and a second backfill run
  was idempotent (same 3-entry index, no duplicates/errors); expired that
  same record and injected an unrelated orphan index entry with no backing
  record → ran `/api/cleanup` → confirmed it reported `deleted: 1` (only
  the genuinely expired record) while the orphan silently vanished from
  the index without being counted.
- **Not yet exercised:** production deploy; performance at the actual
  1,000-share scale the original question was about (the mock KV test used
  a handful of records to verify correctness, not load) — SMEMBERS itself
  is O(N) in the SIZE OF THE INDEX (not the whole keyspace), which is the
  intended improvement, but this wasn't independently re-benchmarked
  against a large synthetic index.

### (b) Per-IP rate limiting on request-link — ADOPTED 2026-09-13 (`5eb7245`)
- **Was:** the campaign's hardening menu item 2 — see
  bunny-sharing-email-gate-campaign for mechanism and validation predicate.
- **What shipped:** `lib/rateLimit.js` — `allowRequestFromIp(req, limit=10)`
  keyed on `gateip:<ip>` with a 60s TTL, plus `clientIp(req)` (first
  `x-forwarded-for` entry, then `x-real-ip`). Wired into BOTH
  `pages/api/watch/request-link.js` and `pages/api/bundle/request-link.js`,
  placed AFTER the existing 400 for a missing body but BEFORE any `kvGet`,
  so a spray costs one read rather than a record lookup plus a send. An
  over-limit request returns the same `genericOk()` as every other branch —
  invariant 4 holds on this path too, so rate limiting can never become an
  oracle for which tokens are real. Deliberately a coarse fixed window with
  a non-atomic read-modify-write: it is a spam dampener, not a security
  boundary (the email gate is that), and concurrent requests may undercount.
  Fails OPEN on a missing IP (local dev, non-proxied hosts) and on any KV
  error.
- **Verified:** `npm run build` clean; unit tests in `tests/kvBacked.test.mjs`
  against an in-memory stand-in for the Upstash REST API cover allow-up-to-
  the-cap-then-block, per-IP bucket isolation, and both fail-open paths;
  `clientIp` header precedence covered in the same file; `grep -c
  "genericOk()"` re-run on both endpoints.
- **Not yet exercised:** the actual HTTP route with a real
  `x-forwarded-for` from Vercel's edge; behaviour under genuine concurrency
  (the undercount is reasoned about, not measured); no live pass. Note this
  is a WEAKER evidence level at route level than items (f)-(j) got — see
  failure-archaeology Episode 12's evidence-shape table.

### (c) Single-use magic links — ADOPTED 2026-09-13 (`5eb7245`)
- **Was:** the campaign's top-ranked hardening item. A grant verified every
  time it was presented inside its 15-minute TTL, so an intercepted or
  forwarded sign-in link was replayable.
- **What shipped:** `lib/singleUse.js` — `isGrantSpent(grant)` /
  `markGrantSpent(grant, expiresAtMs)` over a `gateused:<sha256(grant)>` key
  whose TTL is the grant's own remaining life, plus `grantFingerprint()` in
  `lib/gate.js`. The grant is stored HASHED, never raw: a KV dump of live
  credentials would be worth more to an attacker than the replay protection
  is worth to us. Wired into the grant-exchange branch of BOTH
  `pages/watch/[token].js` and `pages/bundle/[bundleId].js`. Two decisions
  worth preserving: (1) a spent grant falls through to the SAME
  "that sign-in link has expired" form as a genuinely expired one, so a
  replay is indistinguishable from a stale link and reveals nothing;
  (2) ONLY the cookie-setting exchange spends a grant — no other path does —
  which is the mitigation for an email-client prefetcher burning the link,
  per the campaign's own trade-off note. Best-effort by design: both
  functions swallow KV errors and log, degrading to the previous
  replayable-within-TTL behaviour rather than locking out a recipient
  holding a valid grant (never-break-live-links outranks replay protection).
- **Verified:** `npm run build` clean; `tests/kvBacked.test.mjs` covers
  spend-once, cross-grant isolation, TTL tracking the grant's remaining
  life, no marker written for an already-dead grant, that the RAW grant is
  never stored, and the fail-open path; `tests/gate.test.mjs` covers
  `grantFingerprint` determinism and that it is not the grant itself.
- **Not yet exercised:** the exchange inside either page at route level (no
  mock-server pass), the prefetcher scenario against a real mail client, and
  anything live. This is the bounded exception to the stateless-grant design
  in architecture-contract 2.2 — that section now documents it.

### (d) Admin auth upgrade (middleware.js) — STEP 1 ADOPTED 2026-09-13 (`5eb7245`); rest still OPEN
- **Was:** single shared credential, plaintext `===` comparison (not
  timing-safe), no lockout.
- **What shipped (step 1 only — the constant-time compare):**
  `lib/safeCompare.js`'s `timingSafeEqualStr(a, b)`. The Edge-runtime
  question the old first-step note raised was answered: `node:crypto`'s
  `timingSafeEqual` is NOT available in middleware, so this uses the
  WebCrypto fallback that note anticipated — a "double HMAC" under a
  random per-call key, comparing two fixed-length 32-byte digests with
  branch-free XOR accumulation. Fixed-length digests mean the comparison
  can't leak secret length; the random key means even a sloppy digest
  comparison would reveal nothing about the plaintext. In `middleware.js`
  both halves are ALWAYS evaluated (`Promise.all`, no `&&` short-circuit),
  so a right username with a wrong password costs the same as a wrong
  username. A `slowEqualStr` fallback covers a missing `crypto.subtle` and
  never throws — an auth check must not become a 500. New explicit guard:
  `if (auth && user && pass)`, so unset env vars reject everyone as before
  and the compare can never be handed a stringified `undefined`.
- **Verified:** `npm run build` clean, `Proxy (Middleware)` still registers
  with the now-async middleware; `tests/safeCompare.test.mjs` covers equal,
  unequal, length-differing, correct-prefix, unicode, and the
  `undefined`-guard case; invariant greps re-run (matcher unchanged, 401 +
  `WWW-Authenticate` challenge untouched, geo block still strictly inside
  the credential-match branch).
- **Not yet exercised:** the timing property is argued from construction,
  NOT measured on Vercel's Edge runtime. Nobody has benchmarked
  correct-vs-incorrect credential latency. Treat "constant-time" here as
  "no data-dependent branch we can see", not as a measured result.
- **Still open (the larger half):** a single shared credential, no lockout,
  no named users, no per-admin audit. Named users remain a scope change
  needing its own design pass — do not bolt them onto this file.

### (e) Bunny list pagination (lib/bunny.js) — ADOPTED 2026-09-13 (`5eb7245`)
- **Was:** `itemsPerPage=100` with no `page` param, in BOTH `listVideos()`
  and `listCollections()`. Video #101 silently never appeared in the admin
  grid and therefore could never be shared. This was a live data-loss bug,
  not a hardening candidate — it sat in this register from 2026-07-18 to
  2026-09-13 because nobody's library had crossed 100 yet.
- **What shipped:** a shared `listAllPages(buildUrl)` walker plus a
  `bunnyGet(path)` helper (both module-private). The walk stops on a short
  or empty page OR once `totalItems` is reached — both conditions, because
  neither alone is reliable across Bunny's list endpoints. `MAX_PAGES = 200`
  is a hard stop so a malformed or hostile `totalItems` can never spin
  forever. `PAGE_SIZE = 100` is unchanged, so a library at or under one page
  makes exactly ONE request with the same order and the same shape as
  before.
- **Verified:** `npm run build` clean; `tests/bunny.test.mjs` stubs the
  Bunny API and asserts 250 items come back across exactly 3 page requests,
  42 items come back in exactly 1 (no speculative second call), an
  exactly-100 library does not loop past the empty page, collections
  paginate identically, and a non-ok response still throws
  `Bunny API error: <status>` rather than silently returning a short list.
- **Not yet exercised:** a REAL Bunny library with more than 100 videos.
  The stub reports `totalItems` honestly; a real endpoint that omits or
  misreports it would fall back to the short-page condition, which is
  covered by construction but not observed. The original "result when"
  predicate — a seeded library of 101+ videos listing all of them through
  `/api/videos` — is still unmet.

### (f) Email-send failure handling — ADOPTED 2026-07-20
- **Was:** the KV record was written BEFORE the email sends; a mailer
  failure then returned 500 — so a share existed that no one was told
  about (confusing ghost). This is no longer open; kept here as the
  record of what shipped and how it was verified, per lifecycle rule 5.
- **What shipped:** `setEmailFailed(token, failed, errorMessage)`
  (lib/shares.js) sets/clears additive `emailFailed`/`emailError` fields
  (clears via `undefined`, so the key is dropped from JSON rather than
  left `false` — absence means "no known failure"). `pages/api/share.js`
  and `pages/api/share-bulk.js` now catch each recipient's send failure
  individually, flag that recipient's record(s), and report `failures` in
  the response instead of 500ing a batch that partially succeeded (a
  single-recipient `/api/share` call still 500s if its one send fails —
  there's nothing else to report). New admin-only endpoint
  `pages/api/share/resend.js` (covered by the same middleware matcher as
  every other `/api/*` route) re-sends from the stored record and clears
  the flag on success. `pages/index.js` shows a red "⚠ email failed"
  badge (title = the error) and a "Resend" button next to Revoke.
- **Verified:** L0 (`npm run build` clean, route registered) + a live L2/L3
  pass against a mock Upstash-REST KV and a mock SMTP listener (both
  throwaway, not committed): created a share with SMTP unreachable → record
  persisted with `emailFailed: true` + the real connect error →
  `/api/share/resend` with SMTP still down → 502, flag stays → fixed SMTP →
  resend → `{"ok":true}` → `emailFailed`/`emailError` both absent from the
  record afterward. Bulk: 2 recipients × 2 videos with working SMTP → 4
  distinct tokens, no flags; killed SMTP mid-batch for a 3rd recipient →
  both of that recipient's records flagged, other recipients unaffected.
  Middleware boundary re-checked: `/api/share/resend` 401s without admin
  creds; `/api/watch/request-link` unaffected (still public, still 400 on
  empty body).
- **Not yet exercised:** live Resend API failures specifically (only SMTP
  failure was simulated) — the `deliver()` chokepoint means the same
  flag/resend path applies, but if Resend's SDK throws a differently-shaped
  error, `err.message` could read oddly in `emailError`. Low risk, unverified.
- **Follow-up 2026-07-20 (same day):** resend was generalized beyond
  failure-recovery. `resendOne` (exported from `pages/api/share/resend.js`)
  is no longer gated on `emailFailed` — any active share can be re-sent on
  demand (e.g. a recipient says they never got it, even though nothing was
  flagged). New `pages/api/share/resend-bulk.js` accepts `{tokens: [...]}`
  and resends each independently via the same `resendOne`, reporting
  `{succeeded: [...], failures: [...]}` — never fails the whole batch on one
  bad token. `pages/index.js` now shows a Resend button on EVERY active
  share row (not just flagged ones) plus row checkboxes and a "Resend N"
  bulk bar above the shares table, mirroring the existing video-selection
  bulk-share bar's pattern. Verified live (same mock KV/SMTP harness):
  resend succeeded on a share that never had `emailFailed` set; bulk resend
  of 3 valid tokens + 1 nonexistent token returned all 3 successes plus one
  `{error: "Share not found"}` failure without affecting the others;
  revoking a token mid-batch correctly produced `{error: "Share is revoked
  or expired"}` for that token only; both endpoints 401 without admin creds.

### (g) Automated tests — FIRST SUITE ADOPTED 2026-09-13 (`5eb7245`); coverage still thin
- **Was:** no tests, no linter, no CI. Every lifecycle rule-3 prediction was
  verified by hand, twice if you were careful.
- **What shipped:** `npm test` → `node --import ./tests/register.mjs --test
  tests/*.test.mjs`. 50 cases across seven files: `gate.test.mjs` (sign/
  verify round-trip, expiry, token binding, signature AND payload tampering,
  malformed input, bundle-vs-video token separation, fingerprint
  properties), `kvBacked.test.mjs` (single-use and per-IP against an
  in-memory stand-in for the Upstash REST API), `bunny.test.mjs`
  (pagination, with a stubbed API), `settings.test.mjs` (the full
  watermark resolution order), `shares.test.mjs` (`parseEmails` fan-out,
  `normalizeNote`, `SITE_URL` fail-loud), `shareQuery.test.mjs` (status
  derivation, filters, paging clamps, analytics rollup), `csv.test.mjs`
  (quoting and formula-injection escaping).
- **One mechanism worth knowing:** the app's source uses extensionless
  relative imports (`from "./kv"`), which Next's bundler resolves and plain
  Node ESM does not. Rather than rewrite every import across the codebase —
  a wide cosmetic diff against a repo whose first rule is to change as
  little as possible — the runner installs a test-only resolver hook
  (`tests/resolve-hook.mjs`, registered by `tests/register.mjs`) that
  retries a failed relative resolution with `.js`. Nothing shipped depends
  on it. If you ever add `"type": "module"` to package.json or convert the
  imports, delete the hook rather than leaving two mechanisms.
- **Verified:** 50/50 passing. One test bug was found and fixed while
  writing them: the payload-tamper case originally rebuilt a payload that
  could land byte-identical to the signed one (same `Date.now()`
  millisecond) and so passed on its own signature. It now forges a
  different recipient. Watch for that shape in any new crypto test.
- **Route-level tests followed same day.** `tests/helpers/harness.mjs`
  routes a single `globalThis.fetch` stub to in-memory doubles for BOTH the
  Upstash REST API and the Resend HTTP API — both are plain fetch clients,
  so no module mocking and still no new dependency — plus Next-style
  `req`/`res` doubles. Four route files (`tests/routes.*.test.mjs`) now
  cover `/api/watch/request-link`, `/api/watch/request-access`,
  `/api/watch/track`, `/api/share`, `/api/shares`, `/api/shares/export` and
  `/api/analytics`. 83 cases total. Notably this is the first time
  invariant 4 (uniform responses) has been checked by actually
  byte-comparing the branches rather than counting `genericOk()` greps.
- **Still open — what the suite does NOT cover:** anything inside a JSX
  file, which plain Node cannot parse and this repo has no transform for.
  That means the grant→cookie exchange, `maxViews` enforcement at render,
  geo enforcement, and every React component (the Analytics near-miss in
  failure-archaeology Episode 12 still would not be caught). See item (r),
  which is the fix. Also still no linter and no CI, so nothing runs any of
  this automatically on push.

### (h) Bulk "bundle" landing page — ADOPTED 2026-07-20
- **Was:** a bulk recipient got N links in one email with no single page
  listing them. Kept here as the record of the design decisions and what
  shipped, per lifecycle rule 5.
- **Design decisions made:** entity = new `bunnybundle:<id>` record
  (`lib/bundles.js`) holding ONLY `{id, email, tokens, createdAt, expiresAt}`
  — never a member's title/status, which is always re-read live from that
  member's own `bunnyshare:<token>` record (no second source of truth; see
  architecture-contract 2.6/5.1a). Gate semantics = ONE email verification
  unlocks the WHOLE bundle: the grant→cookie exchange
  (`pages/bundle/[bundleId].js`) mints a `gate_bundle_<id>` cookie for the
  listing page AND a standard `gate_<token>` cookie for every member, so
  clicking through to any video plays immediately without a second
  verification — while every video still independently re-checks
  revoked/expired on every render, so revocation and per-person tracking are
  completely unaffected.
- **What shipped:** `lib/bundles.js` (`createBundleRecord`,
  `getBundleMembers`); `pages/bundle/[bundleId].js` (gate + listing page,
  mirrors `pages/watch/[token].js`'s structure); `pages/api/bundle/request-link.js`
  (public, mirrors `pages/api/watch/request-link.js` — same uniform
  anti-enumeration response, same 15-min/30s TTL/throttle constants);
  `sendBundleMagicLinkEmail` (lib/mailer.js); `middleware.js` matcher widened
  to `"/api/((?!watch/|bundle/).*)"`; `pages/api/share-bulk.js` now creates
  one bundle per recipient per call and adds one "view them all in one
  place" line to the existing bulk email (additive, existing per-video links
  unchanged); `pages/api/cleanup.js` now also sweeps expired
  `bunnybundle:*` records (bundles have no `revoked` flag, expiry only).
- **Verified:** L0 (`npm run build` clean, both new routes registered) + a
  live L2/L3 pass against a mock Upstash-REST KV and a mock SMTP listener:
  bulk-shared 2 videos to one recipient → got a `bundleLink` in the API
  response → opened it unauthenticated → email form (not the list) →
  requested the bundle magic link → extracted the real grant from the raw
  SMTP message → exchanged it → response set THREE cookies in one response
  (`gate_bundle_<id>` + both `gate_<token>`s) → bundle listing then showed
  both videos as links → opening one video page directly with its own
  minted cookie played immediately (no re-verification) → revoked one member
  via `/api/revoke` → that video's `/watch` page showed "revoked" AND the
  bundle listing simultaneously downgraded that entry to non-clickable
  "Vid One — revoked" text while the other stayed a live link (proves no
  second source of truth) → a tampered grant on the bundle URL fell back to
  the email form, not the list. Middleware boundary re-checked:
  `/api/bundle/request-link` reachable unauthenticated (400 on empty body,
  not 401); `/api/share/resend` and `/api/shares` still 401 without admin
  creds. Anti-enumeration uniformity re-checked for the new endpoint
  (right/wrong/nonexistent-bundle all byte-identical responses).
- **Not yet exercised:** production deploy (P4-style, real https +
  Secure-cookie flag). The "no persistent bundle link in the shares table"
  gap noted here originally was closed 2026-07-21 — see item (k).
- **Follow-up 2026-07-20 (same day) — one bundle per email, not per call:**
  requirement: "if they are the same email, they should be in the same
  email" — repeat shares to a recipient (from any endpoint, in any order)
  should land in one running notification, not pile up separate emails.
  `findOrExtendBundle` (`lib/bundles.js`) replaces the plain
  `createBundleRecord` call in both `share-bulk.js` and (newly) `share.js`:
  it looks for an existing active bundle for the email first and extends it
  (union tokens, re-max expiresAt) instead of creating a second one; if none
  exists yet, it also sweeps in any other still-active, not-yet-bundled
  `bunnyshare:*` records for that email (covers shares made before this
  widening, or via the single-share endpoint before it participated in
  bundles at all) so the FIRST bundle for someone already reflects
  everything currently shared with them. `getBundleItems` (`lib/bundles.js`)
  builds `{videoTitle, link}` for a bundle's currently-active members, reused
  by both endpoints' emails so the content sent is always "everything active
  right now," not just "what this call created." `/api/share.js` sends the
  plain original single-video email only when the bundle it just
  created/extended has exactly one member (a genuine first-and-only share);
  the moment a second one exists (this call or a prior one, either
  endpoint), it sends the same consolidated multi-item email
  `share-bulk.js` uses. Verified live against the mock KV/SMTP harness:
  two separate `/api/share` calls to the same address → first sends the
  plain email, second sends ONE email listing BOTH videos with the SAME
  bundle link as the first response; a bulk share followed by a single
  share to the same recipient consolidated the same way across endpoints; a
  manually-injected pre-existing un-bundled `bunnyshare` record was folded
  into a brand-new bundle by the orphan sweep; a REVOKED orphan record was
  correctly excluded from the sweep (bundle stayed single-member, plain
  email sent); an unrelated third recipient's share was unaffected (still
  gets the plain email, distinct bundle). Not yet exercised: behavior at
  meaningfully large numbers of bundles/shares (the orphan sweep is two full
  `KEYS` scans on a cold bundle — same accepted-for-now performance class as
  roadmap item a, now also reachable from `/api/share.js`, not just admin
  listing/cleanup/bulk).

### (i) Extend a share's expiry — ADOPTED 2026-07-21
- **Was:** the only way to give a recipient more time was revoke + re-share,
  which mints a brand-new token and breaks the existing link/bookmark — the
  one workflow that actively violated the never-break-live-links rule.
- **What shipped:** `extendOne` (exported from `pages/api/share/extend.js`)
  takes `{token, hours}`, rejects revoked records
  (`"Cannot extend a revoked share"`) and non-positive/non-numeric `hours`,
  and otherwise sets `expiresAt = Math.max(Date.now(), record.expiresAt) +
  hours*3600*1000` in place — same token, same URL, same cookie, nothing
  else changes. Deliberately allowed on an ALREADY-EXPIRED (not revoked)
  share — extending from `Date.now()` rather than the stale past expiry, so
  "it died, give me a bit more time" (the common real case) works correctly
  instead of silently landing back in the past for a small `hours` value.
  `pages/api/share/extend-bulk.js` applies the same logic to
  `{tokens: [...], hours}`, reporting `{succeeded, failures}` per token —
  never fails the whole selection on one bad/revoked/missing token, same
  pattern as `resend-bulk`. `extendBundleForToken` (`lib/bundles.js`)
  re-maxes a member's bundle's `expiresAt` too, so the bundle listing
  doesn't lapse before a member that now legitimately outlives it (one-way:
  only ever grows). Admin UI: an "Extend" button appears on every
  non-revoked row (Active OR Expired — unlike Resend/Revoke, which stay
  Active-only) using a plain `prompt()` for the hours value (no new modal —
  matches the codebase's existing use of `confirm()` for lightweight admin
  actions); the existing bulk-select checkboxes (shared with bulk Resend)
  were widened from Active-only to non-revoked, and an "Extend N" button
  sits next to "Resend N" in the bulk bar.
- **Verified:** L0 (`npm run build` clean, both routes registered) + a live
  L2/L3 pass against the mock KV/SMTP harness: created a 1-hour share,
  extended it 48h, confirmed the new `expiresAt` was exactly +48h from the
  OLD value (not from now, since it hadn't expired yet); created a
  ~3.6-second share, let it actually expire, extended it 24h, confirmed the
  new `expiresAt` landed ~24h from `Date.now()` at extend-time, not from the
  long-past stale expiry; extending a revoked share returned the exact
  rejection message and left `expiresAt` untouched; extending one member of
  a 2-video bundle by 500h correctly re-maxed the bundle's own `expiresAt`
  to match; bulk extend with a mix of a valid token and nonexistent/garbage
  tokens returned the valid one's success plus a `"Share not found"` failure
  per bad token without affecting the good one. Middleware boundary
  re-checked: both new routes 401 without admin creds;
  `/api/watch/request-link` unaffected.
- **Not yet exercised:** production deploy, and un-revoking a share was
  deliberately left OUT of scope — extend refuses revoked records outright
  rather than quietly doubling as an undo for Revoke, which should stay a
  separate, explicit, and more carefully considered action if it's ever
  added.

### (j) Bulk revoke — ADOPTED 2026-07-21
- **Was:** Revoke only existed as a single-token action; an admin wanting to
  cut off several shares at once (e.g. an entire batch shared to the wrong
  address) had to click Revoke once per row.
- **What shipped:** `revokeOne(token)` (exported from `pages/api/revoke.js`)
  extracted the existing single-revoke logic and made it explicitly
  idempotent — revoking an already-revoked record is a no-op success, not an
  error, so a batch containing one already-revoked token doesn't spuriously
  fail. `pages/api/revoke-bulk.js` applies `revokeOne` to
  `{tokens: [...]}`, reporting `{succeeded, failures}` per token — same
  never-fail-the-whole-batch pattern as `resend-bulk`/`extend-bulk`. Admin
  UI: the existing multi-select checkboxes (shared with bulk Resend/Extend,
  visible on any non-revoked row) gained a "Revoke N" button (danger-styled,
  with the same `confirm()` guard the single-row Revoke button already uses)
  in the same bulk bar.
- **Verified:** L0 (`npm run build` clean, route registered) + a live L2/L3
  pass against the mock KV/SMTP harness: bulk-revoked 2 of 3 created shares
  in one call alongside 1 nonexistent token → both valid ones flipped to
  `revoked: true`, the third untouched, the bogus one reported as a clean
  `"Share not found"` failure; re-revoking an already-revoked token in a
  second bulk call succeeded (no error) proving idempotency; the pre-existing
  single-token `/api/revoke` endpoint's behavior (200 on success, 404 for an
  unknown token) was unaffected by the refactor. Middleware boundary
  re-checked: `/api/revoke-bulk` 401s without admin creds.
- **Not yet exercised:** production deploy. Bulk revoke was NOT extended to
  also un-revoke (select revoked rows and restore them) — that's a
  meaningfully different, riskier action (silently restoring access someone
  deliberately cut off) and was left out of scope on purpose, same reasoning
  as item i's decision not to let Extend double as an undo for Revoke.

### (k) Restore (un-revoke) + persistent bundle link in admin table — ADOPTED 2026-07-21
- **Was:** two gaps left open by prior entries as deliberately out of scope
  or noted as low priority: (1) items (i) and (j) both refused to let Extend
  or bulk-revoke double as an "un-revoke," leaving no way to undo an
  accidental Revoke short of re-sharing (a new token, breaking the old
  link); (2) item (h) noted the bundle link only ever surfaced once, in the
  bulk-share success toast, with no durable place to find it again.
- **What shipped:** `unrevokeOne(token)` (`pages/api/unrevoke.js`, mirroring
  `revokeOne`'s shape) flips `revoked` back to `false` — same flag-flip,
  never-delete model as Revoke (non-negotiable 9), idempotent the same way.
  Kept as its own single-token endpoint, deliberately NOT folded into Extend
  or given a bulk form yet, for the same reasoning items (i)/(j) gave for
  leaving it out: restoring cut-off access is a more consequential action
  than extending or revoking, and shouldn't ride along with either as a
  side effect. Admin UI: a "Restore" button appears only on revoked rows.
  Separately, `bundleLinksForTokens(tokens, siteUrl)` (`lib/bundles.js`)
  scans `bunnybundle:*` ONCE and maps every token in the list to its
  bundle's link, rather than one scan per token; `/api/shares.js` calls it
  for the whole listing and attaches `bundleLink` to each record in the
  response only (not stored on the `bunnyshare:*` record itself). Admin UI
  shows it as a small "bundle page" link under the `/watch/<token>` link on
  any row that has one, always visible regardless of that share's own
  Active/Expired/Revoked status.
- **Verified:** L0 only so far (`npm run build` clean; `/api/unrevoke`
  registered; invariant greps re-run: matcher unchanged, `bunnyshare:`
  prefix unchanged, no stray bare `share:` keys, `revoked = true`/`revoked:
  false` both present with no `kvDel`, cookie name/path unchanged). No live
  L2/L3 pass yet against the mock KV/SMTP harness — unlike items (f) through
  (j), this entry has NOT been exercised end-to-end with real records.
- **Not yet exercised:** a live pass proving (a) a revoked share's Restore
  button brings it back to exactly its pre-revoke state and an already-
  expired-and-revoked share restores to "Expired" (not a working link,
  since Restore doesn't touch `expiresAt`); (b) a share belonging to a
  2+-member bundle shows the same bundle link as its siblings in the admin
  table; (c) a share NOT in any bundle shows no bundle link and the API
  response for it is byte-identical to before this change (no stray
  `bundleLink: undefined` key). Also: no bulk Restore, and production
  deploy, both deliberately out of scope for the reasons above.
- **Follow-up 2026-07-21 (same day) — Delete permanently:** requirement
  ("still have option to permanently revoke after that soft revoke") —
  Restore made Revoke fully reversible, so a separate irreversible option
  was added back for when that's actually wanted. `permanentlyDeleteOne`
  (`pages/api/revoke-permanent.js`) requires `record.revoked === true`
  (rejects with `"Only a revoked share can be permanently deleted"`
  otherwise) and then `kvDel`s the `bunnyshare:<token>` record — the exact
  same deletion `/api/cleanup.js` already performs in bulk for
  revoked-or-expired records, just on-demand for one token. This does NOT
  touch non-negotiable 9 (Revoke itself stays a flag flip): it's a distinct
  second action, only reachable from an already-revoked row, so there's no
  one-click path from Active straight to deletion. A bundle referencing the
  deleted token isn't updated — `getBundleMembers`/`getBundleItems`
  already treat a missing member record as "skip it," identical to what
  happens today when cleanup deletes a bundled share. Admin UI: a "Delete
  permanently" button appears next to Restore, only on revoked rows, with
  a confirm() that says the action is irreversible.
- **Not yet exercised:** same gap as the entry above — L0 only (build clean,
  route registered, invariant greps re-run: matcher unchanged, `revoke.js`
  still flag-only with no `kvDel`, `cleanup.js`'s deletion logic
  untouched). No live pass proving (a) deleting an active (non-revoked)
  share is refused; (b) deleting a revoked share removes it from
  `/api/shares` and its token starts 404ing appropriately at `/watch/<token>`
  the same way a cleaned-up record does; (c) a deleted share that belonged
  to a bundle simply disappears from that bundle's listing page rather than
  erroring it.

### (l) Geo location whitelist — ADOPTED 2026-07-22
- **Was:** access control had two dimensions (does the recipient control the
  right inbox — the email gate; is the link still live — revoke/expiry) but
  no way to restrict WHERE a video could be watched from at all, regardless
  of who verifies.
- **What shipped:** `lib/geo.js`'s `isGeoAllowed(req, whitelist)` compares
  Vercel's `x-vercel-ip-country` header against an admin-configured list of
  ISO 3166-1 alpha-2 codes. New `geoWhitelistCountries` field in
  `lib/settings.js` (default `[]`, meaning unrestricted — same
  additive/inert-until-set pattern as every other settings field), with a
  `normalizeCountryList` sanitizer keeping only well-formed 2-letter codes,
  uppercased. Enforced in `getServerSideProps` of BOTH
  `pages/watch/[token].js` and `pages/bundle/[bundleId].js`, checked right
  after the existing not-found/revoked/expired checks and BEFORE the
  magic-link/cookie flow starts — a geo-blocked visitor never even sees the
  email form. Deliberately fails OPEN when the header is missing (local dev,
  non-Vercel hosts): the whitelist is inert rather than a silent lockout off
  the target platform. Admin UI: a new "Geo location whitelist" block in the
  existing Settings panel, plain comma/space-separated text input, same
  pattern as the watermark exemption lists.
- **Verified:** L0 only (`npm run build` clean, both routes still register;
  invariant greps re-run: middleware matcher unchanged, `gate_<token>`
  cookie name/path unchanged, `genericOk` uniform-response block in
  `pages/api/watch/request-link.js` untouched — this feature intentionally
  does NOT touch that endpoint at all, since anti-enumeration invariant 4 is
  scoped to it specifically, not to the `/watch`/`/bundle` pages, which
  already had distinguishable invalid/revoked/expired states before this).
  No live pass yet.
- **Not yet exercised:** a live pass proving (a) setting a whitelist that
  excludes the tester's own country actually blocks `/watch` and `/bundle`
  with the new reason text, while an included country still reaches the
  email gate; (b) the fail-open path — confirmed only by code reading, not
  by an actual non-Vercel-header request — behaves as "allowed" rather than
  throwing or blocking; (c) a malformed value typed into the Settings field
  (e.g. "usa", "12", empty) is dropped by `normalizeCountryList` rather than
  stored and silently never matching. Also out of scope on purpose: no
  per-share or per-video override layer (unlike watermark) — this is a
  single global list for now, since there's no concrete request yet for
  finer-grained geo control.
- **Follow-up 2026-07-22 (same day) — admin geo whitelist:** requirement
  ("why not env var list, so admin can be protected too, and won't have
  complete lockout") — extend geo restriction to the admin surface itself
  (`/` and its `/api/*` routes, i.e. everything middleware.js already
  guards with Basic Auth), while structurally avoiding the lockout trap a
  KV-only design would create: if the country list lived in the same
  Settings record the admin UI edits, and an admin enabled it against their
  own country, they'd have no way back in — the fix would be behind the
  very page it broke. Resolved by SPLITTING the two concerns: the country
  list is `adminGeoWhitelist()` (`lib/geo.js`), read only from the
  `ADMIN_GEO_WHITELIST` env var, never from KV/Settings — recovery is
  always "edit the env var in your hosting dashboard and redeploy," a
  surface this app's own gate can't touch. The ONLY thing that lives in
  Settings is `adminGeoWhitelistEnabled` (`lib/settings.js`), a plain
  runtime on/off toggle (default off) so an admin can flip enforcement
  without a redeploy in the common case. `middleware.js` — the one file in
  this repo requiring the most caution (non-negotiable 7) — was made
  `async` to add ONE conditional `kvGet` (only when
  `adminGeoWhitelist().length > 0`, i.e. zero cost for every deployment
  that hasn't set the env var) strictly INSIDE the existing
  `if (u === user && p === pass)` block (that line became
  `if (userOk && passOk)` on 2026-09-13 — see item (d); the geo block's
  placement inside the credential-match branch is unchanged, which is the
  property that matters here): unauthenticated or wrong-credential
  requests take the exact same path and get the exact same 401 as before —
  the geo check never runs for them, so it can't become a way to probe
  valid credentials or leak info pre-auth. `pages/api/settings.js`'s GET
  now decorates the response with `adminGeoWhitelistCountries` (the env
  var's parsed value) for display only — POST/`saveSettings` has no field
  for it and cannot persist it. Admin UI: a new "Admin access geo
  whitelist" block in Settings shows the configured countries (or "not
  configured") read-only, with just the enforcement checkbox editable.
- **Verified:** L0 only (`npm run build` clean, `Proxy (Middleware)` route
  still registers with the now-async `middleware()`; invariant greps
  re-run: matcher unchanged, the credential compare unweakened (it was
  `u === user && p === pass` at the time; constant-time since 2026-09-13),
  the 401 + `WWW-Authenticate` challenge for bad/missing creds untouched,
  and read-confirmed that the whole geo block sits inside the credential-
  match branch). No live pass yet.
- **Not yet exercised:** a live pass proving (a) with `ADMIN_GEO_WHITELIST`
  set and the toggle OFF, admin access from any country is unaffected
  (matches the "off by default, even if the env var is set" design); (b)
  with the toggle ON and the tester's country excluded, valid credentials
  from that country get a 403 rather than the 401 challenge (distinguishing
  "wrong creds" from "right creds, wrong region" was a deliberate choice,
  unverified live); (c) the fail-open path when `x-vercel-ip-country` is
  absent (local dev) — confirmed only by code reading; (d) the actual
  recovery story — unset `ADMIN_GEO_WHITELIST` and redeploy while
  "locked out" — has never been rehearsed end-to-end, only reasoned about.
- **Follow-up 2026-07-22 (same day) — recipient whitelist moved to env var
  too:** requirement ("actually wanted everything including the original
  geo whitelist to be in env var not just admin whitelist") — the
  recipient-facing list (originally the `geoWhitelistCountries` KV/Settings
  field from earlier the same day) was inconsistent with the admin design
  above for no good reason; unified onto the identical pattern. New
  `GEO_WHITELIST` env var + `recipientGeoWhitelist()` (`lib/geo.js`,
  refactored alongside `adminGeoWhitelist()` to share a `parseWhitelist`
  helper). `lib/settings.js`: `geoWhitelistCountries` (an editable KV array)
  was REPLACED by `geoWhitelistEnabled` (a plain runtime toggle, same shape
  as `adminGeoWhitelistEnabled`); `normalizeCountryList` was deleted as
  dead code once nothing validated a stored list anymore. Because this
  field existed for less than a day and was never certified or (as far as
  this repo's history shows) deployed, replacing rather than deprecating it
  was judged safe — flagged here explicitly in case that judgment call
  needs revisiting. `pages/watch/[token].js` and `pages/bundle/[bundleId].js`
  both changed their check from `isGeoAllowed(req, settings.geoWhitelistCountries)`
  to `settings.geoWhitelistEnabled && isGeoAllowed(req, recipientGeoWhitelist())`.
  `pages/api/settings.js` GET now decorates BOTH `geoWhitelistCountries` and
  `adminGeoWhitelistCountries` read-only from their env vars; neither is
  ever accepted by POST. Admin UI: the recipient-facing Settings block lost
  its free-text textarea and gained the same read-only-display-plus-toggle
  shape as the admin block.
- **Verified:** L0 only (`npm run build` clean; invariant greps re-run:
  matcher/credential-compare/cookie unchanged; confirmed via grep that no
  code path still reads/writes a persisted `geoWhitelistCountries` KV
  field). No live pass yet — same gaps as the admin entry above, now
  doubled (recipient side was never live-verified even under the original
  KV design before this follow-up replaced it).

### (m) Sorted share index so paging cuts KV reads — OPEN (opened 2026-09-13)
- **Why:** `/api/shares` is now filtered and paged server-side, but
  `loadAllShares()` (lib/shareQuery.js) still does SMEMBERS + one GET per
  token on EVERY call. Paging cut response size and browser render work —
  the thing that actually hurt at a few hundred shares — but not the read
  count. Ordering is newest-first and filters match `email`/`videoTitle`,
  all of which live inside the records, so there is nothing cheaper to sort
  or filter on today.
- **Asset:** `bunnyshare-index` already exists and is maintained on create
  (`lib/shares.js`) and delete (`cleanup.js`, `revoke-permanent.js`).
- **First steps:** (1) add a Redis sorted set scored by `createdAt`
  alongside the existing index — additive, never a rename (non-negotiable
  1); (2) prediction: a page of 50 costs ~51 KV ops regardless of total
  share count, versus N+1 today; (3) decide what status/search filters do
  when they can no longer be applied before paging — likely: page the
  sorted set, then filter within the page, and accept approximate counts,
  OR keep the full scan only for filtered queries. Write that decision down
  BEFORE coding; it is the whole design.
- **Result when:** `/api/shares?page=1` on a synthetic 1,000-share index
  issues a bounded number of KV ops that does not grow with the total, and
  `/api/analytics` (which legitimately needs every record) is the only
  remaining full reader.

### (r) Extract the watch/bundle access decision out of the JSX pages — OPEN (opened 2026-09-13)
- **Why:** the single most security-critical decision path in the app — is
  this visitor allowed to watch, and does this grant spend — lives inside
  `getServerSideProps` in `pages/watch/[token].js` (and its twin in
  `pages/bundle/[bundleId].js`), which are React files containing JSX.
  Plain Node cannot import them and the repo has no JSX transform (only
  `@swc/helpers`, a runtime shim, is installed), so that logic is
  permanently unreachable from the test suite while it lives there. Every
  other comparable path in this codebase is already in `lib/` and is
  tested. This is the highest-value testability change available.
- **Asset:** the logic is already a mostly-pure function of
  `(record, settings, query, cookies, now)` returning a decision; the JSX
  around it only renders the result.
- **First steps:** (1) move the body of `watchProps` into
  `lib/watchAccess.js` as a function taking the record/settings/request
  facts and returning `{decision, props?, cookie?, redirect?}` — the page
  keeps fetching and applying, so `res.setHeader` and `kvSet` stay in the
  page; (2) prediction, written BEFORE coding: for every one of the
  existing manual §2 checklist cases the returned decision matches what the
  page does today, and `npm run build` plus the full suite stay green;
  (3) add route-style tests for the exchange, replay, `maxViews`, geo, and
  cookie shape, then delete the "JSX-page half" row from
  validation-and-qa's golden inventory.
- **Compatibility:** this is a pure refactor — it must not change the
  cookie name, path, grant format, or any response. Class (c)/(d) under
  change-control: it touches the gate. Do it on its own, never bundled.
- **Result when:** `pages/watch/[token].js` contains rendering only, the
  access decision is covered by automated tests including the single-use
  replay case, and the manual §2 single-use checklist becomes a
  belt-and-braces rather than the only evidence.

### (n) Audit log of grant exchanges — OPEN
- Owned by the campaign's hardening menu item 4. Now the highest-ranked
  UNBUILT hardening item, since items 1 and 2 shipped 2026-09-13.

### (o) Cookie/grant lifetime tuning — OPEN
- Owned by the campaign's hardening menu item 3. Pure policy choice; nobody
  has made it. Note it interacts with item (c): now that magic links are
  single-use, a shorter cookie life means more magic-link round-trips, each
  of which is now a one-shot credential. Decide them together.

### (p) View-cap administration — OPEN (opened 2026-09-13)
- **Why:** shares gained an optional `maxViews` cap (`5eb7245`), enforced in
  `pages/watch/[token].js` beside revoked/expired. But Extend moves
  `expiresAt` only — it does not touch `viewCount` — so a used-up share
  stays used up, and there is NO admin action that raises or resets a cap.
  The only recovery is re-sharing, which mints a new token and breaks the
  recipient's existing link: exactly the workflow item (i) existed to
  eliminate.
- **First steps:** (1) decide whether the action is "raise the cap" or
  "reset the count" — they differ in what the audit trail says happened;
  (2) mirror `extendOne`'s shape in `pages/api/share/` including its refusal
  on revoked records; (3) prediction: a used-up share becomes live again
  with the SAME token, URL and cookie.
- **Result when:** a used-up share can be restored to working without a new
  token, and the admin table's "Used up" status clears.

### (q) Bulk Restore — OPEN
- Revoke, resend and extend all have bulk forms; Restore deliberately does
  not (see item (k) for the reasoning: restoring access someone deliberately
  cut off is more consequential than extending or revoking). Revisit only if
  a real "I revoked the wrong batch" incident occurs. Listed so the asymmetry
  reads as a decision, not an oversight.

## 3. Positioning: standard vs actually nice

Standard practice, competently applied (claim nothing): magic links, HMAC-SHA256
signed tokens, signed CDN URLs, Upstash KV, Basic Auth for a single admin.

Genuinely nice design worth preserving (the things a refactor would most
easily destroy): the uniform-response anti-enumeration gate; Path-scoped
per-share cookies (`gate_<token>`; one verification never leaks across
shares); the stateless grant design (nothing to store, rotation = instant
global invalidation); per-video tokens in bulk (independent revocation by
construction).

## 4. Where ideas come from here (observed, not aspirational)

Through 2026-07-22, every adopted idea originated from: a security scanner
finding (CodeQL → escapeHtml/isValidUrl), a real incident (thumbnail 403s →
signCdnUrl), or a concrete user request (bulk + email gating → the
2026-07-18 build). None came from speculative refactoring. Implication:
prefer instrumenting and listening (audit log, error surfacing) over
inventing features.

**2026-09-13 is the first exception, and it cuts both ways.** That batch
(`5eb7245`) came from an open-ended "suggest features" request, not from an
incident or a specific ask. Read honestly:

- The items that were already in THIS register — (b), (c), (d), (e), (g) —
  were the valuable half. They had been sitting here with first steps
  written; the request was just the occasion to execute them. Item (e) in
  particular was a live bug shipping silently.
- The invented half — view caps, notes, first-play notification, access
  requests, CSV export, table filtering — had no user asking for any of it.
  It is plausible, it is documented, and it is unproven in the only sense
  that matters: nobody has yet said they wanted it. Some of it may be dead
  weight. Item (p) exists because one of those inventions (view caps)
  shipped with an administration gap that a real user would hit first.

So the rule stands, with a refinement: when asked for ideas, mine this
register before inventing anything, and mark invented features as
speculative in the changelog so a later session can tell which features
earned their place and which merely got built.

## When NOT to use this skill

- Executing the gate certification → bunny-sharing-email-gate-campaign.
- Understanding current design/invariants → bunny-sharing-architecture-contract.
- Checking if an idea was already rejected → bunny-sharing-failure-archaeology.
- Classifying/gating a change you've picked → bunny-sharing-change-control.

## Provenance and maintenance

Written 2026-07-18 against branch claude/bulk-share-separate-links-auth-cblrle.

- (a) still adopted: `grep -rln "kvKeys" pages lib` should show ONLY
  `pages/api/backfill-index.js` (plus `lib/kv.js`'s own definition) —
  anything else means a KEYS scan crept back into a hot path
- (b)/(c) still adopted: `grep -rn "allowRequestFromIp" pages/api` (both
  request-link endpoints) and `grep -rn "isGrantSpent" pages` (both gate
  pages) — a missing hit means a hardening item was reverted
- (d) step 1 still adopted: `grep -n "timingSafeEqualStr" middleware.js`
  (constant-time compare present; a bare `u === user` returning means it
  regressed)
- (e) still adopted: `grep -n "page=\${page}" lib/bunny.js` (two hits: videos
  and collections) — `itemsPerPage=100` alone with no `page` is the bug
- (g) still adopted: `npm test` (expect 83+ passing); `ls tests/*.test.mjs tests/routes.*.test.mjs`
- (r) still open: `grep -c "getServerSideProps" "pages/watch/[token].js"` —
  while the access decision still lives in the JSX page, it is untestable
- (m) still open: `grep -n "loadAllShares" lib/shareQuery.js pages/api` —
  while `/api/shares` still calls it, paging has not cut the read count
- (f) still adopted: `grep -n "setEmailFailed" pages/api/share.js` (failure is flagged, not 500'd)
- Entry ownership: campaign items → `grep -n "Hardening menu" .claude/skills/bunny-sharing-email-gate-campaign/SKILL.md`
- Remove or update entries here as they are adopted (record outcomes in failure-archaeology).
