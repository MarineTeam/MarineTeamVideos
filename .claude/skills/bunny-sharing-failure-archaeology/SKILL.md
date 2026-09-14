---
name: bunny-sharing-failure-archaeology
description: >
  The historical chronicle of this repo: every significant investigation, dead
  end, rejected approach, and reversal, with commit-hash evidence. Load this
  BEFORE proposing any idea that might have been tried already (SMTP
  verification/hardening, KV key renames, auth providers like Auth0/Clerk, CI
  scanners, OTP flows, dependency pins) or when you need to know WHY the code
  is the way it is. Do NOT load for live debugging of a current symptom (use
  bunny-sharing-debugging-playbook) or for executing a new change (use
  bunny-sharing-change-control). Sibling skills own current-state reference:
  bunny-sharing-architecture-contract (invariants), bunny-sharing-roadmap
  (future work).
---

# Bunny-Sharing Failure Archaeology

This is the chronicle of settled battles. Its one job: **no future session
re-fights an argument that has already been fought and decided.** Before you
propose adding, removing, or "improving" anything in this repo, scan the
episode list below. If your idea appears here with Status: SETTLED, do not
re-litigate it — either accept the recorded decision or take the disagreement
through `bunny-sharing-change-control` with new evidence.

Repo state when this was written (2026-07-18): branch
`claude/bulk-share-separate-links-auth-cblrle` at `5905bba`; `main` at
`65dc992`. Full history was 18 commits at that point (anything newer is not
chronicled here) — read it yourself:

```bash
git log --all --oneline --graph
```

**Episode format** (used throughout):
- **Symptom/Trigger** — what prompted the work
- **What was tried** — including approaches later abandoned
- **Root cause / decision** — what turned out to be true, and what was decided
- **Evidence** — commit hashes and file references (verify with `git show <hash>`)
- **Status** — SETTLED (do not reopen without new evidence) / OPEN (unsolved,
  owned by another skill) / CANDIDATE (plausible future work, not committed to)

---

## Episode 1 — The mailer hardening arc and its reversal

**Symptom/Trigger.** Day one of the project (2026-07-02), email sending was
flaky/untrusted, so a flurry of three "hardening" commits landed within
minutes of each other, all authored the same evening as `dd01768 initial`.

**What was tried** (all verified by reading the diffs):
- `7490382` "Enhance mailer with SMTP validation and verification": threw on
  missing SMTP env vars; called `transporter.verify()` before EVERY send
  ("Test connection BEFORE sending"); emoji console logging of send results
  including `info.messageId`, `info.accepted`, `info.rejected` (i.e. recipient
  addresses in server logs).
- `4d9189f` "Enhance error handling and input validation": added
  `console.log("📥 Share request:", { videoId, email, hours })` — recipient
  email logged on every share — and, **as an unnoticed regression**, changed
  the link base fallback from `https://${req.headers.host}` to
  `http://${req.headers.host}`.
- `1a2e4db` "Refactor SMTP transporter configuration": added `requireTLS:
  true` and `tls: { rejectUnauthorized: true }` with comments like "Forces
  proper upgrade to TLS on port 587".

**Root cause / decision.** One day later, `30ecd7f` "Fix" (2026-07-03)
stripped ALL of it — `lib/mailer.js` and `pages/api/share.js` were reverted
essentially byte-for-byte to their `dd01768` shapes. The commit message says
nothing, but the revert is total and deliberate. Inferable rationale:
- `transporter.verify()` per send doubles SMTP round-trips (latency on every
  share) and couples every send to a separate connectivity check that can fail
  independently — a probe failure blocks a send that would have succeeded.
- The logging leaked recipient emails and message metadata into server logs
  (PII/noise).
- `requireTLS`/`tls` options added failure modes without a demonstrated need;
  the simple `secure: port === 465` heuristic (587 → STARTTLS is nodemailer's
  default behavior) was sufficient.

**Evidence.** `git show 7490382`, `git show 4d9189f`, `git show 1a2e4db`,
`git show 30ecd7f`. Current mailer: `lib/mailer.js` — no verify(), no env
throw, no send logging; env selection logic now lives in `deliver()`
(lib/mailer.js:32).

**Status: SETTLED.** Do NOT reintroduce `transporter.verify()` on the send
path, per-send env validation throws, or logging of recipients/message IDs.
If you need a one-off SMTP connectivity probe, it belongs in standalone
diagnostics tooling (see `bunny-sharing-diagnostics`), never inline in
`deliver()`. Note: since `5905bba` the primary email path is the Resend HTTP
API anyway (Episode 8); SMTP is the fallback.

---

## Episode 2 — The hidden migrations inside `30ecd7f` "Fix"

**Symptom/Trigger.** The same `30ecd7f` commit that reverted the mailer
hardening (Episode 1) silently bundled in unrelated, behavior-changing
migrations under a one-word commit message.

**What it actually contained** (four distinct decisions, verified in the diff):
1. The mailer revert (Episode 1).
2. **KV key prefix migration `share:` → `bunnyshare:`** across
   `pages/api/share.js`, `pages/api/revoke.js`, `pages/api/shares.js`,
   `pages/watch/[token].js`. Any share record written before this commit
   became instantly unreachable — its `/watch/<token>` link resolved to "Link
   not found" and it vanished from the admin list. No migration script, no
   dual-read window, no mention in the commit message.
3. **Link fallback `http:` → `https:`** in share.js — actually a *repair* of
   the regression `4d9189f` introduced (initial `dd01768` had already used
   https). Later re-affirmed by the host-header work (Episode 4); today it
   lives in `lib/shares.js:6`.
4. A brand-new feature: `pages/api/cleanup.js` + admin cleanup button.

**Root cause / decision.** This commit is the origin story of the repo's
prime directive — **NEVER BREAK LIVE LINKS** — stated by the maintainer as
the one hard rule: existing tokens, `bunnyshare:*` records and field
meanings, the `/watch/<token>` URL shape, and the `gate_<token>` cookie
name/path must keep working across any change.

**Evidence.** `git show 30ecd7f` (message: literally just "Fix"). Compare
`git show dd01768:pages/api/share.js` for the original prefix and https
fallback.

**Status: SETTLED — two lessons.**
1. Never bundle a silent data-shape migration (key prefixes, record fields,
   URL shapes, cookie names) into an unrelated commit, and never under a
   label like "Fix". Data migrations get their own commit, an explicit
   compatibility story, and change-control review.
2. If you ever see `share:*` keys in the KV store, they are pre-2026-07-03
   orphans, not a bug in current code.

---

## Episode 3 — CVE remediation: next 16, nodemailer 9, postcss override

**Symptom/Trigger.** Dependency audit (2026-07-10) found 34 known CVEs.

**What was done.** `4dd1e44` (merged via PR #7, merge commit `1f1a6c7`):
- `next` 14.2.5 → 16.2.10 (26 Next.js CVEs)
- `nodemailer` 6.9.13 → 9.0.3 (8 Nodemailer CVEs)
- `postcss` `^8.5.10` added as a direct dep AND as an `overrides` entry so
  transitive consumers also get the patched version (PostCSS XSS).

**Root cause / decision.** Straight version-bump remediation; no code changes
were needed. Note the major-version jumps (next 14→16, nodemailer 6→9) were
absorbed without API breakage in this codebase.

**Evidence.** `git show 4dd1e44` (full commit message enumerates the counts);
current `package.json` still pins `next 16.2.10`, `nodemailer 9.0.3`, and
carries the `"overrides": { "postcss": "^8.5.10" }` block.

**Status: SETTLED.** The `overrides` entry is load-bearing CVE remediation —
do not remove it casually (e.g. during a "cleanup" or lockfile regeneration).
Removing it requires re-checking that every transitive postcss is ≥ the
patched version.

---

## Episode 4 — CodeQL findings: XSS + host-header poisoning in email HTML

**Symptom/Trigger.** CodeQL alerts on `lib/mailer.js` (same PR #7 stream as
Episode 3): user-controlled strings (`videoTitle`) interpolated raw into
email HTML (XSS), and share links built from `req.headers.host` flowing
unvalidated into emails (host-header poisoning — an attacker sending a forged
Host header could make the app email out links pointing at their domain).

**What was done.** `29fb9be` (2026-07-10):
- Added `escapeHtml()` (lib/mailer.js:4) and applied it to title, link, and
  date in HTML email bodies.
- Added `isValidUrl()` (lib/mailer.js:15) — parses the URL and requires
  `http:`/`https:` protocol; senders throw "Invalid link URL" rather than
  emailing a bad link.
- Combined with the https fallback in `lib/shares.js:6` (`baseUrl`), and
  `SITE_URL` as the recommended way to pin the link base entirely.

**Evidence.** `git show 29fb9be`. Guards persist in current `lib/mailer.js`
and are applied in all three senders (sendShareEmail, sendBulkShareEmail,
sendMagicLinkEmail).

**Status: SETTLED.** `escapeHtml`/`isValidUrl` are load-bearing security
guards, not decorative helpers. Every new email template MUST route
user-controlled strings through `escapeHtml` and links through `isValidUrl`.
Do not "simplify" them away or bypass them for a new sender.

---

## Episode 5 — External scanners: tried and removed. There is NO CI.

**Symptom/Trigger.** Attempt (2026-07-10) to bolt on third-party security
scanning via GitHub Actions.

**What was tried.**
- `7c132a5` (15:58:47) added `.github/workflows/black-duck-security-scan-ci.yml`
- `8d9341f` (15:59:09) added `.github/workflows/checkmarx-one.yml`
- `6912077` (16:01:55) deleted the Black Duck workflow
- `6292b64` (16:02:29) deleted the Checkmarx workflow

**Root cause / decision.** Total lifetime of both workflows: about three
minutes. Reading the deleted YAML (`git show 7c132a5:.github/workflows/black-duck-security-scan-ci.yml`)
shows both were stock vendor templates requiring credentials that were never
going to exist here (`vars.BLACKDUCKSCA_URL`, `secrets.BLACKDUCKSCA_TOKEN`,
Checkmarx tenant secrets). They were template experiments, abandoned
immediately — most likely on realizing the vendor accounts/secrets weren't
available.

**Evidence.** The four hashes above; `ls .github` today → the directory does
not exist at all.

**Status: TRIED-AND-REMOVED.** Consequences for you:
- **There is NO CI in this repo today** (no workflows, no tests, no linter).
  Never claim "CI will catch it" or "tests pass" — verification is manual
  (see `bunny-sharing-validation-and-qa`).
- Re-adding third-party scanners is not forbidden, but it is a CANDIDATE that
  requires actual vendor credentials and should go through change-control —
  don't re-add stock templates that can't run.

---

## Episode 6 — Thumbnail 403s: the two-keys / two-encodings trap

**Symptom/Trigger.** Admin page thumbnails returned HTTP 403 whenever Token
Authentication was enabled on the Bunny pull zone backing the Stream library
— while embeds kept working fine.

**What was tried / learned.** The obvious wrong assumption is that
`BUNNY_TOKEN_KEY` (which signs embed URLs) also covers thumbnails. It does
not. Bunny has TWO separate token-auth schemes with different keys AND
different hash encodings:

| | Embed URLs | Direct CDN assets (thumbnails, HLS, MP4) |
|---|---|---|
| Env var | `BUNNY_TOKEN_KEY` | `BUNNY_CDN_TOKEN_KEY` |
| Bunny console location | Library > API > Security (Embed View Token) | Library > API > "CDN zone management" > Manage > Security > Token Authentication |
| Signed string | key + videoId + expires | key + url pathname + expires |
| Digest encoding | sha256 **hex** | sha256 **base64url** (`+`→`-`, `/`→`_`, `=` stripped) |
| Code | `generateEmbedUrl` (lib/bunny.js:56) | `signCdnUrl` (lib/bunny.js:40) |

**Root cause / decision.** `65dc992` (2026-07-14, tip of `main`) added
`signCdnUrl()` and the optional `BUNNY_CDN_TOKEN_KEY` env var; unsigned URLs
are returned as-is when the key is unset (token auth off → no signing
needed). When pull-zone Token Authentication is ON, ALL direct asset URLs
require a signed token — including plain `<img src>` thumbnails.

**Evidence.** `git show 65dc992` (commit message and inline comments document
the whole trap); `.env.example` and README rows added in the same commit.

**Status: SETTLED.** If thumbnails 403: check whether pull-zone Token
Authentication is enabled and whether `BUNNY_CDN_TOKEN_KEY` is set to the
PULL ZONE key (not the embed key). Do not "deduplicate" the two signing
functions or the two env vars — they are intentionally distinct.

---

## Episode 7 — Auth-provider evaluation: Auth0/Clerk REJECTED; gate flow chosen

**Symptom/Trigger.** Requirement (session of 2026-07-18, delivered in
`7e2c016`): possessing a `/watch/<token>` URL alone should no longer grant
access — the recipient must prove control of the email address the link was
shared with.

**What was considered and REJECTED** (recorded here precisely so nobody
re-litigates it):

| Option | Verdict | Why |
|---|---|---|
| Auth0 | REJECTED | No off-the-shelf primitive for "this one URL ↔ this one email". Would require modeling recipients as users/invitations; full IdP (tenant, universal login, SDK weight, vendor dependency) unjustified for anonymous one-off recipients. |
| Clerk | REJECTED | Same shape of mismatch: user-account-centric; no per-link email binding out of the box; vendor + billing overhead for a ~150-line problem. |
| **Self-built HMAC magic-link gate** | **CHOSEN** | ~150 lines (`lib/gate.js` is 68 lines + endpoint + page wiring), zero new vendors, stateless grants, exact fit for the one-URL-one-email primitive. |

**Gate-flow variants weighed:**

| Variant | Verdict | Why |
|---|---|---|
| Auto-send magic link on page load | Rejected | Emails fire on every visit (bots, prefetchers); also reveals that a gate exists and invites email-bombing. |
| **Type-email-then-magic-link** | **CHOSEN** | Hides the recipient address (you must already know it), and proves inbox control, not just knowledge of the address. Uniform response for match/mismatch/invalid preserves anti-enumeration. |
| Type-email-instant-access (no magic link) | Rejected | Merely *knowing* the email would suffice — no proof of inbox control; email addresses are guessable/leakable. |
| OTP code entry (6-digit) | Rejected for now | More friction (switch to inbox, copy code back) than clicking a link; no security win at this threat level. CANDIDATE alternative if magic-link deliverability/UX proves bad in the live campaign. |

**Resulting design** (all in `7e2c016`): stateless HMAC-SHA256 grants signed
with `GATE_SECRET` (`lib/gate.js` — fails loud if unset, lib/gate.js:15-19;
`timingSafeEqual` verify, lib/gate.js:55); public endpoint
`pages/api/watch/request-link.js` with identical generic 200 for
invalid/mismatch/success (request-link.js:20-24, 33-40) and a 30 s per-token
throttle `gatethrottle:<token>` (request-link.js:42-48); 15-min magic-link
TTL; HttpOnly link-scoped cookie `gate_<token>` set by
`pages/watch/[token].js`. Bulk sharing in the same commit: N videos → N
records → N independently revocable links, one consolidated email.

**Evidence.** `git show 7e2c016` (full design rationale in commit message);
the files above at current HEAD.

**Status: SETTLED** (Auth0/Clerk rejection; type-email-then-magic-link flow).
OTP remains a labeled CANDIDATE. The gate itself is functionally complete but
**unproven in production** — that is Episode 10 / the campaign skill.

---

## Episode 8 — Resend integration: SMTP-bridge first, corrected to native API

**Symptom/Trigger.** Resend was chosen as the email provider during the
2026-07-18 session. First integration (`7e2c016`) used Resend only via its
SMTP bridge — the commit message literally says "Uses SMTP
(Resend-compatible) for delivery" (smtp.resend.com / 587 / user `resend` /
pass = API key).

**What was corrected.** Four minutes later, `5905bba` switched the primary
path to Resend's native HTTP API: when `RESEND_API_KEY` is set, all three
senders route through `resend.emails.send()`; plain SMTP via nodemailer
remains the automatic fallback when it is not set. All senders were refactored
onto a single `deliver({ to, subject, text, html })` helper
(lib/mailer.js:32) with `from` resolved as `RESEND_FROM || SMTP_FROM ||
SMTP_USER` (lib/mailer.js:24-26).

**Root cause / decision.** The HTTP API is Resend's native, recommended
interface (better errors, no SMTP handshake, works where outbound 587/465 is
blocked). The SMTP bridge remains a *deliberate escape hatch*: leave
`RESEND_API_KEY` unset and configure the SMTP_* vars to use Resend-over-SMTP
or any other provider.

**Evidence.** `git show 7e2c016` (last bullet of message), `git show 5905bba`;
current `lib/mailer.js`.

**Status: SETTLED.** Selection rule to remember: `RESEND_API_KEY` present →
API path wins and SMTP vars are ignored. Keep every future email going
through `deliver()` — never instantiate a transporter in a sender again.

---

## Episode 9 — The comma-string recipient lockout

**Symptom/Trigger.** User report (2026-07-19): "magic link doesn't send if it
was bulk shared to multiple emails, and each email share isn't getting
individual links." Both recipients of a bulk share received the SAME links,
and neither could ever get a magic link — the gate returned its uniform 200
and sent nothing.

**Root cause.** Comma-separated addresses typed into a single `email` field
were stored VERBATIM into one share record per video
(`email: "a@b.c, d@e.f"`). Two failures cascade from that one bad write:
(1) email providers treat a comma-joined string as multiple recipients, so
every address received the same email with the same links — no per-person
records existed; (2) the gate compared the typed single address against the
stored combined string, never matched, and anti-enumeration made the failure
silent. The first multi-recipient server code (`c115034`) fixed the `emails`
array path but left the legacy single-`email` path unsplit — so a stale
client bundle sending the old shape kept reproducing the bug.

**Fix** (2026-07-19): `parseEmails()` in lib/shares.js is now the single
choke point turning user input into a recipient list — it flattens arrays
AND splits commas/semicolons/whitespace inside every element; both
`/api/share` and `/api/share-bulk` fan out one record per parsed address
(single share included: it had the same latent bug). Defense at the gate
too: `request-link` splits a record's stored email and matches the typed
address against ANY of them, sending the magic link to the TYPED address
only — so legacy combined-string records already in KV became usable again
without touching them (never-break-live-links applies to broken data too).

**Evidence.** The commit following `aa1e528`; `parseEmails` in
lib/shares.js; the split-match block in pages/api/watch/request-link.js.

**Status: SETTLED — two lessons.**
1. Any field that accepts "an email" WILL eventually receive several; parse
   at the boundary, never store unparsed input into a matching-critical
   field.
2. Legacy combined-string records still work at the gate but their token is
   SHARED between the listed addresses — per-person revocation and view
   tracking need a revoke + re-share under the current code.

---

## Episode 10 — Open/unsettled register

None of these are settled. Do not treat them as bugs to hot-fix in passing;
each is owned by a sibling skill.

| Item | Detail | Status | Owner skill |
|---|---|---|---|
| Gate unproven live | The email gate (Episode 7) has never been exercised against live Resend + a real inbox + prod Bunny/KV. It is built, not proven. | OPEN — the hardest live problem | bunny-sharing-email-gate-campaign |
| ~~Magic-link grant not single-use~~ | Built 2026-09-13 (`5eb7245`) — `lib/singleUse.js` marks a grant spent by SHA-256 fingerprint at the cookie exchange, TTL = its own remaining life. NOT live-certified; see Episode 12. | BUILT, not proven live | bunny-sharing-email-gate-campaign (hardening menu), bunny-sharing-roadmap (c) |
| ~~No per-IP rate limiting~~ | Built 2026-09-13 (`5eb7245`) — `lib/rateLimit.js`, checked before any record lookup on both public request-link endpoints, over-limit returns the same `genericOk()`. NOT live-certified; see Episode 12. | BUILT, not proven live | bunny-sharing-roadmap (b) |
| ~~KV `KEYS` is O(N)~~ | Fixed 2026-07-22 — index sets + SMEMBERS replace every hot-path KEYS scan; see roadmap item (a). | SETTLED | bunny-sharing-roadmap |
| Plaintext Basic Auth compare | PARTLY closed 2026-09-13 (`5eb7245`): the compare is now constant-time (`lib/safeCompare.js`, WebCrypto double-HMAC — Edge has no `node:crypto` `timingSafeEqual`). Still a SINGLE SHARED credential with no lockout and no named users. | PARTLY SETTLED — shared-credential half still OPEN | bunny-sharing-roadmap (d) |
| ~~Bunny list ceiling~~ | Was never in this register but was live in the code: `itemsPerPage=100` with no `page` param meant video #101+ was invisible and unshareable. Fixed 2026-09-13 (`5eb7245`). | SETTLED | bunny-sharing-roadmap (e) |
| No automated tests | Was true until 2026-09-13 (`5eb7245`), which added a 50-case `node --test` suite. Still no linter and no CI, and the suite is unit-level only — no route-level or live coverage. | PARTLY SETTLED | bunny-sharing-validation-and-qa |
| Record stored before email sent | share/share-bulk write the KV record, then email; a send failure leaves a live record with no delivered link. | OPEN | bunny-sharing-roadmap |

---

## Episode 11 — Host header poisoning, take two: the 2026-07-10 fix was incomplete

**Symptom/Trigger.** CodeQL flagged `lib/mailer.js:53` "host header poisoning
in email generation" as CRITICAL (alerts #5 and #6, duplicated — two taint
paths converging on the same `transporter.sendMail` sink), plus a separate
High "polynomial regular expression" alert (#7) on `lib/gate.js:25`, both
opened against `main` two days after the geo-whitelist work landed.

**What was found on inspection (not assumed from the alert labels).**
- The ReDoS alert was a **false positive**: `b64url()`'s regex chain
  (`\+`, `\/`, `=+$`) benchmarked LINEAR from 1K to 1M-char inputs (~1000x
  input → ~80x time, no blowup) — none of those patterns have the
  nested/ambiguous-quantifier shape that causes catastrophic backtracking.
  Verified with a direct Node benchmark, not just read by eye. No code
  change; the alert should be dismissed with that reasoning.
- The host-header-poisoning alert was **real, and Episode 4's `29fb9be` fix
  never actually closed it**. `29fb9be` added `escapeHtml`/`isValidUrl` to
  `lib/mailer.js`, but `isValidUrl` only checks a link parses as
  `http:`/`https:` — a link to `https://evil.com/watch/<token>` passes that
  check fine. Meanwhile `baseUrl()` (`lib/shares.js`) still fell back to
  `SITE_URL || \`https://${req.headers.host}\`` — a client-suppliable Host
  header, trusted whenever `SITE_URL` was unset. Net effect: a forged
  request could make the app email a real recipient a legitimate-looking
  share/magic-link notification whose link pointed at an attacker's domain.
  The `http:`→`https:` fix in `30ecd7f` (Episode 2) only forced the scheme;
  it never validated the host was actually this app.

**What was done** (2026-07-22): `baseUrl(req)` now REQUIRES `SITE_URL` and
throws if it's unset — the Host-header fallback was removed entirely, same
fail-loud pattern as `GATE_SECRET` (`lib/gate.js`). This is a breaking
config change: any deployment that relied on the auto-detected fallback
(no `SITE_URL` set) now needs to set it. Three options were weighed with
the maintainer before touching it — fail-loud, an opt-in `ALLOWED_HOSTS`
allowlist (non-breaking but only fixes anything for deployments that set
it), or documenting it as accepted risk — maintainer chose fail-loud for a
complete fix.

**A second-order fix this forced.** `baseUrl(req)` is called from the two
PUBLIC, anti-enumeration-sensitive endpoints too
(`pages/api/watch/request-link.js`, `pages/api/bundle/request-link.js`),
each guarded by invariant 4 (`genericOk()` must be byte-identical for every
outcome). Both endpoints' `catch` blocks previously returned
`res.status(500).json({ error: err.message })` on ANY thrown error — and
critically, that catch only fires on the code path AFTER the email already
matched (every earlier miss returns `genericOk()` directly, never reaching
`baseUrl()` or the `catch`). So making `SITE_URL` fail loud would have
turned a misconfiguration into a live oracle: a 500 response distinguishable
from every `genericOk()` 200 would leak exactly "this token+email pair
matched" to anyone probing. This exact same shape of leak already existed
for a missing `GATE_SECRET` (also thrown, also only on the match path) —
this fix closed both at once by making the `catch` blocks in both files
return `genericOk()` unconditionally (logging server-side via
`console.error`, never returning `err.message` to the caller).

**Evidence.** `lib/shares.js` (`baseUrl`), `pages/api/watch/request-link.js`
and `pages/api/bundle/request-link.js` (catch blocks), the Node benchmark
run inline in the session that made this fix (not committed — see the
`lib/gate.js:25` grep in bunny-sharing-change-control's invariant-grep list
if you want to re-verify it's still linear after any future edit to
`b64url`).

**Status: SETTLED** (fail-loud `SITE_URL`; ReDoS alert is a false positive,
dismissible). Two lessons:
1. A partial fix to a CodeQL finding (Episode 4 addressed XSS but not the
   host-trust gap) can leave the alert's own category — "host header
   poisoning" — still genuinely open under a different mechanism. Read what
   the mitigation actually covers before treating an alert as resolved.
2. Any new fail-loud env var check reachable from
   `request-link.js`/`bundle/request-link.js` MUST be re-verified against
   invariant 4 (uniform response) before shipping — a thrown error on the
   success-only path is a structurally different leak than one on a common
   path, and easy to miss.

---

## Episode 12 — The 2026-09-13 batch: three long-open items closed at once, and a near-miss

**Trigger.** A session was asked to suggest features, then to build all of
them. Twelve changes landed in one commit, `5eb7245`. Three of them closed
items that had sat in Episode 10's register since it was written.

**What closed.**
- Single-use magic links (`lib/singleUse.js`) — hardening menu item 1.
- Per-IP rate limiting (`lib/rateLimit.js`) — hardening menu item 2.
- Constant-time admin compare (`lib/safeCompare.js`) — roadmap item (d),
  first step only.
- Bunny list pagination (`lib/bunny.js`) — roadmap item (e). This one was a
  live bug, not a hardening candidate: a library over 100 videos silently
  lost everything past the first page.
- First automated tests (`tests/`, 50 cases) — roadmap item (g).

**The near-miss, which is the part worth remembering.** The same batch made
the admin shares table server-side paged. `computeAnalytics` lived in
`pages/index.js` and was called as `computeAnalytics(shares)` — where
`shares` had, until that moment, always been *every* share. After paging it
would have been one page of 50. The Analytics panel would have kept
rendering, with plausible-looking numbers, silently describing only the
latest 50 shares. Nothing would have errored and no test would have caught
it, because no test covered the panel.

It was caught by re-reading the diff adversarially before pushing, not by
the build, the tests, or the invariant greps. The fix was to move the rollup
server-side (`computeAnalytics` in `lib/shareQuery.js`, exposed at
`/api/analytics`) so it reads every record by construction.

**Lesson, generalized:** when a data source that used to be complete becomes
paged, filtered, or capped, every *derived* consumer of it silently changes
meaning without changing shape. Grep for every reader of the collection you
just narrowed. In this codebase that means: anything reading the `shares`
array in `pages/index.js`, and anything reading `bundle.tokens` or an index
set. A rollup that keeps rendering is not evidence that it is still correct.

**Evidence shape — read this before trusting the batch.** This batch was
verified differently from Episodes (f) through (j) in the roadmap, and less
thoroughly in one specific way:

| Check | This batch | Earlier adopted items (f)-(j) |
|---|---|---|
| `npm run build` clean | yes | yes |
| Invariant greps | yes | yes |
| Automated unit tests | yes (new; 50 cases) | none existed |
| Route-level pass against mock KV + mock SMTP | **no** | yes |
| Live Resend / Bunny / prod KV | no | no |

So: the helper functions are better covered than anything before them, and
the API routes that use those helpers are *less* covered than the routes
added in July, which were exercised end-to-end against throwaway mock
servers. Specifically unexercised at route level: the single-use exchange
inside `pages/watch/[token].js` and `pages/bundle/[bundleId].js`, the per-IP
branch in both request-link handlers, the first-play notification in
`/api/watch/track`, and the whole `/api/watch/request-access` flow. Do not
read "50 tests passing" as "this batch is proven".

**Addendum, same day — route tests, and a test that passed for the wrong
reason.** The evidence-shape table above was closed out within hours by
adding a route-level harness (`tests/helpers/harness.mjs`): one
`globalThis.fetch` router standing in for BOTH the Upstash REST API and the
Resend HTTP API, since both are plain fetch clients. That took the suite
from 50 to 83 cases and covered every API route in the batch. Invariant 4
(uniform responses) is now checked by byte-comparing the branches rather
than by counting `genericOk()` greps — the first time that has ever been
true.

Two things were learned doing it, both worth keeping:

1. **A crypto test can be green and worthless.** The existing "rejects a
   tampered signature" case tampered by flipping the LAST base64url
   character of the signature. A 32-byte HMAC encodes to 43 characters, the
   last carrying only 4 significant bits, so several distinct final
   characters decode to the *same bytes* — the tamper was frequently not a
   tamper, and `verifyGrant` correctly accepted an untampered signature. It
   failed only on runs where the signature happened to end in `A`, which is
   why it passed when run alone and failed in the full suite. Fixed by
   tampering at the byte level (decode, XOR a byte, re-encode) with an
   assertion that the bytes actually changed. **Generalize:** a mutation
   test is only as good as its mutation; assert that the mutation is real
   before trusting a rejection. And run the WHOLE suite — a flake that
   depends on generated data will hide from a single-file run.
2. **The remaining blind spot is architectural, not tooling.** The gate's
   access decision could not be tested at all, because it lives inside
   `getServerSideProps` in a JSX file that plain Node cannot parse and this
   repo has no transform for. The honest response was to scope the tests to
   what was reachable and open roadmap item (r) to extract that logic,
   rather than either skipping the coverage silently or refactoring the
   most security-sensitive page as a side effect of writing tests.

**Second addendum — CodeQL on the new tests, and the same lesson twice.**
CodeQL raised two High "incomplete URL substring sanitization" alerts
against `tests/routes.gate.test.mjs`, on the test asserting that an emailed
magic link points at `SITE_URL` and never at a spoofed request Host. Both
were test-scope, so no production control depended on them, and the easy
call was to dismiss them the way Episode 11's ReDoS alert was correctly
dismissed.

That would have been wrong. Inspecting the assertion rather than the alert
label: `body.includes("https://videos.test/watch/")` passes for a body
containing `https://evil.example.com/x?next=https://videos.test/watch/abc`.
That is precisely the host-header-poisoning shape the test exists to guard
against — so the guard could have been green while the property it claimed
to prove was violated. Fixed by extracting every absolute URL from the body
and asserting on its PARSED host, which is both CodeQL-clean and strictly
stronger than what it replaced.

A `the host assertion above actually bites` test now pins it, by proving
the parsed check DISCRIMINATES: a host laundered through a query parameter,
a clean link, several links in one body, and a suffix lookalike
(`videos.test.evil.example.com`) — that last one guards against anyone
"simplifying" the check back to substring or suffix matching later.

**A third alert, and this one was a genuine false positive — handled
differently.** The first version of that bites-test also asserted that the
OLD substring form passes the poisoned body, to show the contrast. CodeQL
flagged that line too, and correctly: it is a literal instance of the weak
pattern, and the rule cannot distinguish USING a weak check from
DEMONSTRATING that one is weak. Dismissal was available (Episode 11's
precedent). But re-reading the line on its own merits settled it without
needing the scanner's opinion: it compared two string literals in the same
function, so it could never fail and tested no project code. It was
narrative decoration shaped like a test. Removed; the comment carries the
explanation and the real assertions carry the proof.

**Do not reintroduce a literal demonstration of the weak form** — the rule
will fire on it every scan, forever, and the assertion was never worth
anything. Three CodeQL episodes now, with three different correct answers:
benchmark and dismiss (Episode 11's ReDoS), fix because the finding is right
(the substring guard), and delete because the flagged line should not have
existed (this one). The reusable discipline is the same each time: read your
own code, decide on its merits, and let the alert be the prompt rather than
the verdict.

**This is the second time in one session that a test was green for the wrong
reason** — the first was the base64url tamper case earlier in this episode.
Both had the same shape: an assertion whose *mutation or discrimination was
not actually what the author believed*. Generalized rule, now also in
validation-and-qa: when a test claims to reject something, prove it rejects
it — assert the negative case explicitly, in the suite, rather than trusting
that the check discriminates. And take a scanner's finding as a prompt to
re-read your own assertion, not as a verdict to accept or dismiss.

**Status: BUILT, ROUTE-TESTED, NOT CERTIFIED.** No live pass, no deploy,
and the JSX-bound half of the gate remains unautomated.

---

## When NOT to use this skill

- **Debugging a live symptom right now** (403s, emails not arriving, gate
  loops): use `bunny-sharing-debugging-playbook` — it has symptom→triage
  tables. Come back here only if triage suggests "has this been tried
  before?".
- **Making a new change**: use `bunny-sharing-change-control` for change
  classes, gates, and pre-push verification. This skill only tells you which
  battles are already settled.
- **Current-state facts** (invariants, env vars, architecture): use
  `bunny-sharing-architecture-contract` and `bunny-sharing-env-and-setup`.
  History here explains WHY; siblings state WHAT IS.

## Provenance and maintenance

Every claim above was verified against the repo on 2026-07-18 by reading the
actual diffs. If you touch this file, re-verify; wrong archaeology is worse
than none.

- New episodes since this was written? `git log --all --oneline -5` — anything
  newer than `5eb7245` (the 2026-09-13 batch, Episode 12) is not chronicled
  here; read it and add an episode.
- CI still absent? Yes as of `5eb7245`, but tests are NOT: `npm test` runs a
  `node --test` suite (`ls tests/*.test.mjs`). "No tests" claims elsewhere
  predate that commit.
- Re-verify any episode: `git show <hash>` for its Evidence hashes.
- CI still absent? `ls .github/workflows 2>/dev/null` (expect: nothing).
- Overrides still present? `grep -A2 overrides package.json` (expect postcss
  `^8.5.10`).
- Two-key trap still current? `grep -n "digest" lib/bunny.js` (expect one
  `base64` at signCdnUrl, one `hex` at generateEmbedUrl).
- Guards still load-bearing? `grep -n "escapeHtml\|isValidUrl" lib/mailer.js`.
- Cross-references: sibling skills live under `.claude/skills/`; if a named
  sibling is missing, its content may not have been authored yet — do not
  invent its contents.
