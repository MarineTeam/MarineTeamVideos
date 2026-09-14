---
name: bunny-sharing-change-control
description: >
  Change-control policy for the bunny-sharing repo: how to classify a proposed
  change (safe / behavior-affecting / compatibility-critical / security-sensitive),
  which non-negotiable invariants must never be weakened (with the incidents behind
  them), the exact pre-push verification commands, the checklist for touching any
  compatibility-critical surface (tokens, bunnyshare:* records, /watch URLs,
  gate_<token> cookies, GATE_SECRET, grant format), and the documentation that must
  ship in the same change. Load this BEFORE editing or pushing any change to this
  repo, and when reviewing a diff. Do NOT load it for debugging a live failure
  (use bunny-sharing-debugging-playbook), for the history/why behind a decision
  (use bunny-sharing-failure-archaeology), or for detailed test-evidence standards
  (use bunny-sharing-validation-and-qa).
---

# Change control for bunny-sharing

This repo issues live, emailed `/watch/<token>` links to outside recipients. There
is a test suite as of 2026-09-13 (`npm test`, 83 cases — unit plus
route-level) but still NO CI
(two scanner workflows were added and deleted in the past — do not assume CI
exists), and the suite covers helpers and API routes against in-memory
doubles, but nothing inside a JSX page (the gate exchange included) and no
real service. Nothing runs it for you. Verification is therefore still
substantially manual, and this protocol IS the safety net. Follow it before
every push.

**Prime directive (maintainer-stated): NEVER BREAK LIVE LINKS.** Every token ever
emailed must keep resolving; every `bunnyshare:*` record already in Redis must keep
being readable; every `gate_<token>` cookie already set in a recipient's browser
must keep verifying. A change that is correct for new shares but breaks old ones
is a failed change.

Jargon, once:
- **share record** — JSON at Redis key `bunnyshare:<token>` with fields
  `{token, videoId, videoTitle, email, createdAt, expiresAt, revoked}`
  (lib/shares.js, `createShareRecord`).
- **grant** — stateless HMAC-SHA256 credential `b64url(payload).b64url(sig)`
  signed with `GATE_SECRET` (lib/gate.js). Emailed as `?grant=` (15-min magic
  link), then exchanged for a cookie grant.
- **gate cookie** — `gate_<token>`, HttpOnly, `Path=/watch/<token>`, set in
  `pages/watch/[token].js` (`cookieName()` at line 105, Set-Cookie around line 152).

## 1. Change classification

Classify the diff FIRST. A diff takes the class of its most dangerous file. When
in doubt, classify UP.

| Class | Examples in this repo | Required verification before push |
| --- | --- | --- |
| (a) Safe | README prose, comments, inline `styles` objects in pages/index.js or pages/watch/[token].js, admin-UI cosmetics (labels, layout) that do not change fetch calls or form payloads; anything under `tests/` | `npm run build` succeeds (plus `npm test` if you touched `tests/`) |
| (b) Behavior-affecting | pages/api/* handler logic, lib/mailer.js routing/templates, lib/bunny.js, lib/kv.js, middleware.js (including any rename to the `proxy` convention — the build's deprecation warning tempts this; renaming changes auth coverage and is NOT cosmetic), admin UI flows (share modal, bulk bar, revoke button payloads), cleanup logic | Full protocol in section 3, plus manually exercise the changed flow end-to-end (dev server or deploy preview) |
| (c) Compatibility-critical | Anything touching: token format (`crypto.randomBytes(16).toString("hex")`, lib/shares.js:13), the `bunnyshare:` key prefix or record field names/meanings, `/watch/<token>` URL shape, `gate_<token>` cookie name or its `Path=/watch/<token>`, GATE_SECRET semantics (what is signed, how, with what), grant payload/format (`{t,e,x}` + b64url encoding), the `gatethrottle:<token>` key only if repurposed | Section 3 protocol PLUS the backward-compat checklist in section 4. Old artifacts must demonstrably still work |
| (d) Security-sensitive | lib/mailer.js HTML construction (escapeHtml/isValidUrl paths), pages/api/watch/request-link.js AND pages/api/watch/request-access.js AND pages/api/bundle/request-link.js responses, middleware.js matcher/auth logic, lib/gate.js crypto, baseUrl() in lib/shares.js, lib/safeCompare.js, lib/singleUse.js, lib/rateLimit.js | Section 3 protocol PLUS re-verify every invariant grep in section 3 step 3, and re-read section 2 line by line against the diff |

Classes overlap: middleware.js is both (b) and (d); lib/gate.js is (c) AND (d).
Apply the union of requirements.

## 2. Non-negotiables

Each entry: the rule, why, and the incident it comes from. Verify incidents
yourself with read-only `git show <hash>`. Never weaken these; if a change seems
to require it, stop and escalate to the maintainer.

1. **NEVER BREAK LIVE LINKS** — the prime directive, above all others.
   *Incident:* commit `30ecd7f` ("Fix", 2026-07-03) silently migrated the KV key
   prefix `share:` → `bunnyshare:` with no data migration, orphaning every record
   created before it — all previously emailed links died. It also bundled two
   other unrelated decisions into one unlabeled commit. Lessons: (a) any
   read-path key/format change must keep reading old data or migrate it;
   (b) one decision per commit, labeled.

2. **All user-controlled strings in email HTML pass through `escapeHtml`; all
   links pass `isValidUrl`** (lib/mailer.js:4-22; used by all three senders).
   *Why:* video titles and links land in HTML email bodies; unescaped input is
   stored XSS in the recipient's mail client. Note `isValidUrl` only checks the
   link parses as `http:`/`https:` — it does NOT verify the host is actually
   this app; that's invariant 3's job, not this one's (a link to a well-formed
   `https://evil.com/...` URL passes `isValidUrl` fine).
   *Incident:* `29fb9be` (2026-07-10) fixed CodeQL alerts for XSS in email
   generation.

3. **`baseUrl()` REQUIRES `SITE_URL` and fails loudly if it's unset — there is
   no Host-header fallback** (lib/shares.js).
   *Why:* the request `Host` header is client-suppliable. The OLD behavior —
   `SITE_URL || \`https://${req.headers.host}\`` — let a forged Host header
   make the app email real recipients a legitimate-looking notification whose
   link pointed at an attacker's domain. Forcing `https://` (the pre-2026-07-22
   version of this rule) stopped a downgrade to `http:` but never addressed
   the host itself being attacker-controlled — `isValidUrl` (invariant 2) only
   checks protocol, not origin, so it didn't cover this either.
   *Incident:* the `http:` → `https:` fallback flip landed in `30ecd7f`
   (2026-07-03); CodeQL correctly flagged the remaining host-trust gap as
   "host header poisoning in email generation" (alerts #5/#6, critical),
   fixed 2026-07-22 by removing the fallback entirely (fail-loud, same
   pattern as `GATE_SECRET`). See failure-archaeology for the full incident
   — including why the fix also had to touch the public
   `/api/watch/request-link` and `/api/bundle/request-link` catch blocks
   (invariant 4), since a thrown `SITE_URL`-missing error there would
   otherwise produce a response distinguishable from `genericOk()`.

4. **`/api/watch/request-link` and `/api/bundle/request-link` return the
   IDENTICAL generic 200 for invalid link/bundle, revoked/expired,
   mismatched email, throttled, success, AND any unexpected runtime error**
   (`genericOk()` in each file, returned at five sites — the catch block
   included as of 2026-07-22). *Why:* anti-enumeration — the public endpoint
   must not let anyone probe which email a link belongs to, or whether a
   token is live, INCLUDING via an error a misconfiguration might trigger
   (e.g. a missing `SITE_URL`/`GATE_SECRET` only surfacing when the email
   actually matched would itself be an oracle). Any new branch in either
   handler — success, failure, or error — must return `genericOk()`, not a
   distinguishable response, status code, or timing-obvious shortcut.

5. **GATE_SECRET has no default; the gate fails loud** (lib/gate.js:14-22,
   `secret()` throws when unset). *Why:* a silent fallback secret means a
   misconfigured deploy signs forgeable grants — worse than an outage.
   Runtime-only: `next build` succeeds without it (verified 2026-07-18).

6. **Grant verification uses `crypto.timingSafeEqual`, grants are token-bound and
   expiring, and `verifyGrant` never throws on malformed input**
   (lib/gate.js:47-66). *Why:* non-constant-time comparison leaks signature
   bytes; unbound grants would let one share's grant unlock another; throwing on
   garbage input turns probing into 500s.

7. **The middleware matcher keeps `/api/watch/*` public and everything else in
   `/api` plus `/` behind Basic Auth; `/watch/*` pages stay OUT of the matcher**
   (middleware.js:31: `matcher: ["/", "/api/((?!watch/).*)"]`). *Why:* recipients
   have no admin credentials — if the matcher swallows `/api/watch/*` or
   `/watch/*`, every live link breaks behind a 401 (a prime-directive violation);
   if it stops covering the rest of `/api`, the whole admin surface is public.

8. **Bulk share = one token/record/link PER recipient × video pair**
   (pages/api/share-bulk.js loops `createShareRecord` per recipient per
   video; lib/shares.js generates a fresh random token per call). *Why:*
   independent revocation and per-person view tracking — deliberate design
   of the bulk feature (`7e2c016`, extended to multi-recipient + view
   tracking after `c43b96f`). Never "optimize" into one
   shared token.

9. **Revoke = flag flip, never delete** (pages/api/revoke.js:12-13 sets
   `record.revoked = true` and writes back). *Why:* revocation must be
   auditable and reversible; deletion is cleanup's job (pages/api/cleanup.js
   deletes only revoked-or-expired records). Deleting on revoke would also make
   a revoked link indistinguishable from a never-existing one in the admin table.

## 3. Pre-push verification protocol

Run from the repo root, in order. All must pass for class (b)+; step 1 alone
suffices for class (a).

**Step 1 — build (no env required).**
```bash
npm run build
```
Must succeed with zero errors. As of 2026-07-18 it succeeds with NO env vars set
(GATE_SECRET included — it is runtime-only) and prints one expected warning:
`The "middleware" file convention is deprecated. Please use "proxy" instead.`
That warning is known and deliberate — do not "fix" it as a drive-by (see
section 1 class (b)). The route list must still show `ƒ /api/watch/request-link`,
`ƒ /watch/[token]`, and `ƒ Proxy (Middleware)`. Since 2026-09-13 it must also
show `ƒ /api/watch/request-access`, `ƒ /api/shares/export` and
`ƒ /api/analytics`. (`Proxy (Middleware)` registering matters more than it
used to: middleware is now `async` and awaits a WebCrypto compare, so a
failure to register would silently drop the entire admin auth boundary.)

**Step 1b — unit suite (added 2026-09-13).**
```bash
npm test
```
83+ cases, no env vars, no network. Required for every class except (a)
docs-only. If your diff touched a pure helper — `lib/gate.js`,
`lib/shares.js`, `lib/settings.js`, `lib/bunny.js`, `lib/shareQuery.js`,
`lib/csv.js`, `lib/safeCompare.js`, `lib/singleUse.js`, `lib/rateLimit.js` —
ADD a case rather than only re-running the existing ones. Passing this is
NOT evidence that a route works; see bunny-sharing-validation-and-qa's
ladder (it is rung L0.5, below every live level).

**Step 2 — gate crypto self-test** (required whenever lib/gate.js, GATE_SECRET
handling, or pages/watch/[token].js grant logic changed; cheap enough to run
always). Use the self-test script in the **bunny-sharing-diagnostics** skill
(`.claude/skills/bunny-sharing-diagnostics/`) — it signs a grant and asserts
verify-roundtrip, expiry rejection, wrong-token rejection, and tamper rejection.
Do not hand-roll a variant here; keep one canonical script.

**Step 3 — invariant greps.** Each command's output must match the stated
expectation; a mismatch means an invariant moved and the diff needs re-review.

```bash
# Matcher still has the negative lookahead keeping /api/watch/* and
# /api/bundle/* public:
grep -n "watch/" middleware.js
# EXPECT a line: matcher: ["/", "/api/((?!watch/|bundle/).*)"]

# KV prefix untouched — every read/write still uses bunnyshare:
grep -rn "bunnyshare:" lib pages
# EXPECT hits in: lib/shares.js, pages/watch/[token].js,
# pages/api/watch/request-link.js, pages/api/shares.js, pages/api/revoke.js,
# pages/api/cleanup.js — and NO other prefix:
# `grep -rn "share:" lib pages | grep -v bunnyshare:` must print NOTHING
# (no legacy bare `share:` keys may reappear)

# Cookie name/path unchanged. NOTE: this moved out of the page on
# 2026-09-13 (roadmap item (r)) — the watch cookie is now built in
# lib/watchAccess.js. The bundle cookie is still built in its page.
grep -n "gate_\|Path=/watch" lib/watchAccess.js
# EXPECT: cookieName() returning `gate_${token}`, and buildGateCookie()
# producing `...; HttpOnly; Path=/watch/${token}; SameSite=Lax; Max-Age=...`
grep -n "gate_bundle_\|Path=/bundle" "pages/bundle/[bundleId].js"
# EXPECT: the bundle cookie name and its own Path scope
# Stronger than either grep: tests/watchAccess.test.mjs asserts the exact
# watch cookie string. If you change that string, that test fails — which is
# the point. Do not "fix" it without reading non-negotiable 1.

# SITE_URL fail-loud, no Host-header fallback (2026-07-22 fix):
grep -n "SITE_URL is not set\|req.headers.host" lib/shares.js
# EXPECT: the throw message present; NO match for req.headers.host at all

# Public gate endpoints never let an error become a distinguishable
# response (5 genericOk() call sites each, including the catch block):
grep -cn "genericOk()" pages/api/watch/request-link.js pages/api/bundle/request-link.js

# Uniform responses — every outcome branch returns genericOk. As of
# 2026-09-13 there are THREE such endpoints and SIX return sites each
# (the per-IP rate-limit branch was added to all of them):
grep -n "genericOk" pages/api/watch/request-link.js
grep -n "genericOk" pages/api/bundle/request-link.js
grep -n "genericOk" pages/api/watch/request-access.js
# EXPECT each: 1 definition + 6 return sites (rate-limited, missing/revoked/
# expired, email mismatch, throttled, success, catch-block error)

# Single-use magic links: spent ONLY at the cookie-setting exchange
grep -n "isGrantSpent\|markGrantSpent" "pages/watch/[token].js" "pages/bundle/[bundleId].js"
# EXPECT: both functions in each file, inside the `if (query.grant)` branch
# only. A spend on any other path is a bug (prefetcher DoS).

# Constant-time admin compare, both halves always evaluated
grep -n "timingSafeEqualStr" middleware.js
# EXPECT: two calls inside a Promise.all — NOT behind `&&`, and NO bare
# `u === user` anywhere

# Fail-loud secret and constant-time compare still present:
grep -n "GATE_SECRET\|timingSafeEqual" lib/gate.js
# EXPECT: the throw-if-unset in secret(), and timingSafeEqual in verifyGrant

# Escaping still applied in mailer:
grep -n "escapeHtml\|isValidUrl" lib/mailer.js
# EXPECT: both defined and used in ALL of sendShareEmail, sendBulkShareEmail,
# sendMagicLinkEmail

# Revoke still flags, never deletes:
grep -n "revoked = true\|kvDel" pages/api/revoke.js
# EXPECT: `record.revoked = true` present; kvDel ABSENT
```

**Step 4 — exercise the changed flow** (class (b)+). `npm run dev` with a filled
`.env.local` and walk the affected path end-to-end (create share → email →
/watch → email gate → magic link → playback, as applicable). What counts as
sufficient evidence per surface is defined in **bunny-sharing-validation-and-qa**;
runnable probes live in **bunny-sharing-diagnostics**.

## 4. Changing a compatibility-critical surface (class c)

Almost never do this. If you must, the change is only pushable with ALL of the
following backward-compat evidence, gathered against records/cookies created by
the CURRENT code before your change:

- [ ] **Old token still resolves.** Create a share on the pre-change code, then
      run the post-change code against the same Redis: `GET /watch/<old-token>`
      renders the email gate (not "Link not found").
- [ ] **Old record shape still reads.** Every consumer (`pages/watch/[token].js`,
      shares list, revoke, cleanup, request-link) handles a record with exactly
      the old fields `{token, videoId, videoTitle, email, createdAt, expiresAt,
      revoked}`. New fields must be optional with safe defaults; no field may be
      renamed or change meaning.
- [ ] **Old cookie still verifies.** A `gate_<token>` cookie minted pre-change
      (same GATE_SECRET) still passes `verifyGrant` post-change and plays the
      video without re-gating the recipient.
- [ ] **Old emailed magic link still works** within its 15-min TTL across the
      deploy: `?grant=` signed pre-change verifies post-change.
- [ ] **Key prefix:** if the prefix or key layout changes at all, ship a
      migration that copies/aliases every existing `bunnyshare:*` key BEFORE the
      read path changes, and prove it against production-shaped data. (This is
      the exact failure of `30ecd7f` — do not repeat it.)
- [ ] **GATE_SECRET rotation** counts as a class (c) change: it invalidates every
      outstanding cookie and magic link. Only acceptable with maintainer intent
      (e.g. suspected leak), stated in the commit message.
- [ ] The commit message names the surface changed and the compat evidence
      collected — one decision per commit, labeled (anti-`30ecd7f`).

## 5. Documentation obligations (same commit, not a follow-up)

Verified present as of 2026-07-18:
- README.md has an **Environment variables** table (starts line 39) and an
  **API routes** table (starts line 55).
- `.env.example` lists every env var with comments.

Rules:
- Add/rename/remove an env var → update ALL THREE in the same change: README
  env-var table, `.env.example`, and any behavior notes (e.g. the
  RESEND_API_KEY-wins-over-SMTP selection rule).
- Add/rename/remove an API route → update the README API routes table in the
  same change, and state whether the route is behind Basic Auth or public
  (public requires a matcher decision — see non-negotiable 7).
- If the change alters recipient-visible behavior (/watch flow, emails), update
  the README "How it works" section.
- Add/change a KV key namespace → update the architecture contract's
  auxiliary-key table (section 5.1). The ephemeral namespaces today are
  `gatethrottle:`, `bundlethrottle:`, `gateused:`, `gateip:`, `accessreq:`.
- **Adopting something from the roadmap, or discovering something worth
  remembering → update the SKILL FILES in the same change.** This is not
  optional bookkeeping: these skills are what a zero-context session reads
  as truth, and a skill that still calls a shipped feature "OPEN" will cause
  it to be built twice. The 2026-09-13 batch shipped without this and left
  four skills stale for a day — see failure-archaeology Episode 12. At
  minimum: the roadmap item's outcome, the architecture contract's
  weak-points row, failure-archaeology's open register, and
  validation-and-qa's golden inventory.

## 6. When NOT to use this skill

- **Something is broken and you're diagnosing it** → bunny-sharing-debugging-playbook
  (symptom → triage). Come back here before pushing the fix.
- **You want the history or the "why" behind a decision/incident** →
  bunny-sharing-failure-archaeology (full chronicle; this skill only cites hashes).
- **You need the detailed standard for what counts as test evidence, or E2E
  checklists per surface** → bunny-sharing-validation-and-qa.
- **You need runnable probes/self-tests** → bunny-sharing-diagnostics.
- **You're deciding architecture, not gating a diff** → bunny-sharing-architecture-contract.

## Provenance and maintenance

Facts verified against the working tree on 2026-07-18 (branch
`claude/bulk-share-separate-links-auth-cblrle`, HEAD `5905bba`). Re-verify with:

- Matcher: `grep -n "matcher" middleware.js` (expect `["/", "/api/((?!watch/).*)"]`)
- Prefix + record shape: `grep -rn "bunnyshare:" lib pages` and `sed -n '12,30p' lib/shares.js`
- Cookie name/path: `grep -n "gate_\|Path=/watch" "pages/watch/[token].js"`
- Fail-loud secret / timingSafeEqual: `grep -n "GATE_SECRET\|timingSafeEqual" lib/gate.js`
- Uniform responses: `grep -n "genericOk" pages/api/watch/request-link.js` (1 def + 5 returns)
- Revoke-is-flag: `grep -n "revoked = true" pages/api/revoke.js`
- Build-without-secret claim: `env -u GATE_SECRET npm run build` (rerun if Next.js is upgraded; deprecation warning text may change)
- Incidents: `git show --stat 30ecd7f` and `git show 29fb9be -- lib/mailer.js`
- Doc tables: `grep -n "Environment variables\|API routes" README.md`; `cat .env.example`
