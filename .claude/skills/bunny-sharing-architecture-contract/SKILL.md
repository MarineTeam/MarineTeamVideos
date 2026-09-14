---
name: bunny-sharing-architecture-contract
description: >
  The architecture contract for the bunny-sharing repo: load-bearing design
  decisions with their WHY, the numbered security invariants, the honest
  register of known weak points, and the exact record/grant/cookie formats
  that the never-break-live-links rule protects. Load this BEFORE designing
  any change that touches auth, tokens, KV records, the middleware matcher,
  email sending, or the /watch flow — or when you need to know why something
  is built the way it is. Do NOT load for how-to-run/deploy questions
  (bunny-sharing-run-and-operate), Bunny signing or email domain theory
  (bunny-stream-reference / email-delivery-reference), or the history
  narrative of past incidents (bunny-sharing-failure-archaeology).
---

# bunny-sharing architecture contract

This is the design contract for "Bunny Video Sharing": a small Next.js (Pages
Router) app that shares private Bunny.net Stream videos with outside
recipients via time-limited, revocable, email-gated `/watch/<token>` links —
without giving recipients any Bunny library access. If you change anything
this file describes, you are changing the contract; read the matching
Decision's "What breaks" first, and route the change through
`bunny-sharing-change-control`.

Verified against the working tree at commit `5905bba` on 2026-07-18. Every
claim cites the source file; when this document and the code disagree, the
code wins — then fix this document.

Jargon, defined once:

- **share token**: 32 hex chars (`crypto.randomBytes(16).toString("hex")`,
  `lib/shares.js:13`). Identifies one share of one video to one email.
- **share record**: the JSON object at KV key `bunnyshare:<token>` — the
  single source of truth for a share (schema in section 5).
- **grant**: a stateless HMAC-signed string proving "this holder demonstrated
  control of the recipient email for this share" (`lib/gate.js`). Exists in
  two flavors: the 15-minute *magic-link grant* (emailed) and the *cookie
  grant* (lives until the share expires).
- **gate**: the whole email-verification flow (form → magic link → cookie).

## 1. System diagram

```mermaid
flowchart TB
  subgraph AdminSide["Admin surface (HTTP Basic Auth via middleware.js)"]
    Admin[Admin browser] --> Index["/ (pages/index.js)"]
    Index --> APIvideos["/api/videos"]
    Index --> APIshare["/api/share"]
    Index --> APIbulk["/api/share-bulk"]
    Index --> APIshares["/api/shares"]
    Index --> APIrevoke["/api/revoke"]
    Index --> APIcleanup["/api/cleanup"]
  end

  subgraph Backends
    KV[("Upstash Redis REST\nbunnyshare:* records\nlib/kv.js")]
    Bunny["Bunny Stream API\nlib/bunny.js"]
    Mail["Email provider\nResend API or SMTP\nlib/mailer.js deliver()"]
  end

  APIvideos --> Bunny
  APIshare --> KV
  APIshare --> Mail
  APIbulk --> KV
  APIbulk --> Mail
  APIshares --> KV
  APIrevoke --> KV
  APIcleanup --> KV

  subgraph RecipientSide["Recipient surface (PUBLIC — never behind Basic Auth)"]
    Rcpt[Recipient browser] -->|"1. opens emailed /watch/&lt;token&gt;"| Watch["/watch/[token]\npages/watch/[token].js"]
    Watch -->|"2. no grant → email form POSTs"| ReqLink["/api/watch/request-link"]
    ReqLink -->|"3. email matches record"| Mail
    Mail -->|"4. magic link ?grant= (15 min)"| Rcpt
    Rcpt -->|"5. clicks magic link"| Watch
    Watch -->|"6. sets cookie gate_&lt;token&gt;, redirects clean URL"| Rcpt
    Watch -->|"7. valid cookie → signed iframe embed (3600 s)"| Player["iframe.mediadelivery.net"]
  end

  Watch --> KV
  ReqLink --> KV
```

Two access factors gate playback: **possession of the URL** (unguessable
token) **and control of the inbox** (magic link). Neither alone suffices.

## 2. Load-bearing decisions

Each entry: Decision / Why / What breaks if you change it. These are not
suggestions; they are the reasons the system is safe and simple.

### 2.1 Two factors: possession-of-URL + control-of-inbox

- **Decision**: A `/watch/<token>` link alone never plays the video. The
  recipient must also complete the email gate (type the matching email,
  click the magic link). Introduced in commit `7e2c016`; enforced by
  `pages/watch/[token].js` getServerSideProps (no cookie grant → email form)
  and `pages/api/watch/request-link.js` (email must match `record.email`).
- **Why**: Links get forwarded, pasted in chats, and leaked from inboxes.
  The unguessable token stops guessing; the inbox check stops forwarding.
  A full IdP (Auth0/Clerk) was considered and rejected in `7e2c016`: none
  offers an out-of-box "one URL ↔ one email" primitive, and the self-built
  HMAC gate is ~150 lines with zero vendor dependencies.
- **What breaks**: Rendering the embed without a verified grant reduces
  security to possession-only — anyone who sees the URL watches. Requiring
  more than these two factors (accounts, passwords) breaks the "no signup
  for recipients" product premise.

### 2.2 Stateless HMAC grants instead of KV-stored sessions

- **Decision**: Grants are self-contained HMAC-SHA256-signed strings
  (`lib/gate.js`), verified with `GATE_SECRET`. Nothing about a grant is
  stored server-side.
- **Why**: Zero storage and zero cleanup for sessions. Revocation is
  inherited for free: every request to `/watch/<token>` re-loads the share
  record first (`pages/watch/[token].js:122-132`) and rejects
  revoked/expired shares *before* the grant is even checked — so a grant is
  only as alive as its share record.
- **What breaks — and the built-in footgun**: Rotating `GATE_SECRET`
  invalidates **all** outstanding grants at once. That is a feature (instant
  global logout if the secret leaks) AND a footgun (rotate it casually and
  every recipient silently re-verifies; magic links in flight die). If you
  move grants into KV you gain per-grant revocation but inherit storage,
  TTL bookkeeping, and a new failure surface — do not do this without a
  concrete need (see bunny-sharing-roadmap).
- **The ONE bounded exception (added 2026-09-13, `5eb7245`): single-use
  marking.** `lib/singleUse.js` stores a `gateused:<sha256(grant)>` key when
  a MAGIC-LINK grant is exchanged for a cookie, with a TTL equal to that
  grant's own remaining life. This is deliberately the narrowest possible
  breach of "nothing about a grant is stored": it stores a HASH, not the
  grant; it stores nothing for cookie grants, only for the emailed one-shot;
  it stores nothing for a grant that is already expired; and the entry
  self-expires exactly when the grant would have died anyway, so the
  keyspace does not grow. Verification still does not consult storage —
  `verifyGrant` is untouched and remains pure — the spent-check is a
  separate lookup at one call site in each gate page. Crucially it is
  **best-effort**: both helpers swallow KV errors and log, so a store
  failure degrades to the previous replayable-within-TTL behaviour rather
  than locking out a recipient holding a valid grant. That ordering is
  deliberate — never-break-live-links (invariant 1) outranks replay
  protection. Do NOT generalize this into KV-stored sessions; the campaign's
  hardening note that named it "the bounded exception" is the whole licence.

### 2.3 Grant lifecycle: 15-min emailed grant → cookie grant → redirect strip

- **Decision**: `request-link` signs a grant expiring in
  `MAGIC_LINK_TTL_MS = 15 * 60 * 1000` (`pages/api/watch/request-link.js:8`)
  and emails `<site>/watch/<token>?grant=<...>`. On click,
  `pages/watch/[token].js:137-155` verifies it, signs a **new** cookie grant
  whose `expiresAt` equals the share's `record.expiresAt`, sets the cookie,
  and 302-redirects to the clean `/watch/<token>` URL.
- **Why**: The emailed grant must be short-lived because email is the leaky
  channel. The cookie grant may live longer because it is HttpOnly and
  path-scoped. The redirect strips `?grant=` from the address bar and
  browser history so the emailed credential does not linger anywhere
  copyable.
- **Single-use, since 2026-09-13 (`5eb7245`)**: the exchange now also marks
  the magic-link grant spent (section 2.2's bounded exception), and a grant
  already marked spent takes the SAME fall-through as an invalid or expired
  one — the email form with "that sign-in link has expired". A replay is
  therefore indistinguishable from a stale link and reveals nothing about
  whether the grant was ever real. Only this cookie-setting exchange spends
  a grant; no other code path does, which is the deliberate mitigation for
  an email-client link prefetcher consuming the link before the human
  clicks. If you add another place that accepts a `?grant=`, decide
  explicitly whether it spends — and default to no.
- **What breaks**: Lengthening the magic-link TTL widens the interception
  window. Skipping the redirect leaves a live credential in history/referer.
  Spending the grant on a path that does NOT set the cookie turns every
  prefetching mail client into a denial of service against your recipients.
  Making the cookie grant outlive the share is harmless in effect (record
  check still gates) but violates least-surprise; making it shorter forces
  pointless re-verification.

### 2.4 Cookie `gate_<token>` scoped by `Path=/watch/<token>`

- **Decision**: Cookie name is `gate_<token>` and it is set with
  `HttpOnly; Path=/watch/<token>; SameSite=Lax; Max-Age=<until share
  expiry>` plus `; Secure` when the request is https. Since 2026-09-13 the
  name and the exact cookie string are produced by `cookieName()` and
  `buildGateCookie()` in `lib/watchAccess.js` (roadmap item (r)); the page
  only applies the header. The string is asserted verbatim by
  `tests/watchAccess.test.mjs`, so this surface is now protected by a test
  rather than only by a grep.
- **Why**: Path scoping means authorization for one share never rides along
  to another share's page — the browser simply does not send it. The
  deliberate cost: a recipient with five shares verifies five times. That
  trade was chosen; per-share isolation beats convenience here.
- **What breaks**: Widening `Path` to `/watch` (or `/`) makes every cookie
  grant accompany every share page request. Verification would still fail on
  token binding (`verifyGrant(..., { token })`, `lib/gate.js:61`), but you'd
  ship cross-share credentials in every request for no reason, and a future
  verification bug becomes cross-share instead of contained. Renaming the
  cookie breaks live viewers' sessions (invariant 1).

### 2.4a The access decision lives in `lib/`, not in the page (2026-09-13)

- **Decision**: every branch of "may this visitor watch" — not found,
  revoked, expired, view cap, geo, grant exchange, replay, valid cookie,
  no cookie — is `decideWatchAccess()` in `lib/watchAccess.js`. It performs
  NO I/O: the record, settings, cookies, geo verdict and `secure` flag are
  passed in, the "has this grant been spent" lookup arrives as an injected
  `isSpent` callback, and the result is a data description of what to do
  (`invalid` / `exchange` / `need-email` / `authorized`).
  `pages/watch/[token].js` gathers the facts and applies the effects.
- **Why**: the page is a JSX file. Plain Node cannot parse JSX and this repo
  has no transform, so while the decision lived there it was unreachable
  from the test suite — the single most security-critical path in the app
  was the only significant one with no automated coverage. It is now
  covered by 19 cases including the single-use replay, the view cap, geo
  refusal, cookie shape, and a legacy-record-shape compatibility case.
- **What breaks**: putting a branch back in the page silently removes it
  from test coverage. If you add an access rule, add it to
  `decideWatchAccess` and a case to `tests/watchAccess.test.mjs`. The page
  should stay free of `if` statements about access.
- **The bundle page followed the same day**: `decideBundleAccess()` in
  `lib/bundleAccess.js`, same no-I/O contract, with `loadMembers` injected
  alongside `isSpent`. Its per-video cookies are built by watchAccess's own
  `buildGateCookie`, so section 2.6's claim that a bundle exchange mints
  "the same format the per-video gate already produces" now holds by
  construction rather than by two implementations agreeing. There is
  exactly one definition of the `gate_<token>` cookie in the repo; verify
  with `grep -rn "gate_\${token}" lib pages`.

### 2.4b Grant exchanges are audited; the log holds LESS than the records (2026-09-13)

- **Decision**: every grant→cookie exchange, on either entrance, writes one
  `gatelog:<padded-ms>-<rand>` entry — `{at, kind, token, emailHash, ip}` —
  via `recordGrantExchange()` (`lib/gateLog.js`). Read admin-only at
  `/api/gate-log`, newest first.
- **Why the email is hashed**: the share record already holds the address,
  so identity is one lookup away from the token. Storing it again here
  would make the log a SECOND place personal data accumulates, under a
  different retention rule and a different access path. The fingerprint
  still answers the questions a log exists for — was this the intended
  recipient (compare to the record) and did one person exchange across
  several shares (compare hashes). Net: the log holds strictly less than
  the records it points at.
- **Why entries expire**: 90 days, because "append-only forever" in this KV
  store has no retention story — unbounded growth plus an ever-growing pile
  of IP addresses. One constant (`LOG_TTL_SECONDS`) governs it.
- **Why the key has a random suffix**: a bare timestamp collides when two
  exchanges land in the same millisecond, and a colliding write silently
  destroys an audit entry. A log that can lose entries invisibly is worse
  than no log.
- **What breaks**: making the write throwable would let a logging outage
  block a legitimate recipient's sign-in — strictly worse than a gap in the
  log, which is at least visible and diagnosable. Storing the plaintext
  address would reintroduce the second-PII-store problem this design
  avoids. Removing the random suffix reintroduces silent entry loss.

### 2.5 Share record in KV is the truth; the Bunny embed URL is a second, short-lived signing layer

- **Decision**: Authorization lives in the KV record. Playback uses a
  separately signed Bunny embed URL — sha256 **hex** of
  `BUNNY_TOKEN_KEY + videoId + expires`, generated per page view with
  3600 s expiry (`lib/bunny.js:56-65`, called at
  `pages/watch/[token].js:171`).
- **Why**: The KV record gives revocation and audit; the Bunny token stops
  anyone from lifting the iframe `src` and hot-linking it forever. Two
  layers, two jobs.
- **Honest limit**: Revocation takes effect on the **next page load**, not
  mid-playback. A recipient already watching keeps a valid Bunny token for
  up to 3600 s after you revoke. This is accepted; shortening
  `expiresInSeconds` trades that window against playback breaking during
  long videos. Do not claim instant revocation anywhere.
- **What breaks**: Caching the embed URL in the record would freeze the
  `expires` timestamp and dead-link every share after an hour. Note the
  sibling trap: `signCdnUrl` for thumbnails uses a **different key**
  (`BUNNY_CDN_TOKEN_KEY`) and **base64url** encoding (`lib/bunny.js:40-52`)
  — mixing the two schemes was a real incident (`65dc992`); the signing math
  lives in bunny-stream-reference.

### 2.6 Bulk = M×N independent records; bundle is a pure grouping list, never a second source of truth

- **Decision**: `/api/share-bulk` accepts multiple recipients (`emails`
  array; legacy single `email` still accepted) and loops `createShareRecord`
  once per recipient × video pair — M recipients × N videos → M×N tokens →
  M×N records. Each recipient gets ONE consolidated email listing only their
  own links (`pages/api/share-bulk.js`). Falsy video ids are skipped;
  all-invalid input is a 400; a per-recipient email failure is reported in
  the response (`failures`) without failing other recipients.
- **Why**: Independent revocation per person per video, per-person view
  tracking (section 5.1 view fields), and zero new schema for the shares
  themselves. Revoking or letting one member expire never touches any other
  record.
- **Bundle addition (2026-07-20 — see section 5.1a):** every `share-bulk`
  call, and every `share.js` call too (widened same day — see below),
  creates or extends one `bunnybundle:<id>` record per recipient
  (`lib/bundles.js`), listing that recipient's member tokens, and a
  `/bundle/<id>` gated page (`pages/bundle/[bundleId].js`) that lists them.
  The bundle record holds ONLY the token list, email, and its own
  `createdAt`/`expiresAt` (max of members) — it never stores a member's
  title, revoked flag, or status. `getBundleMembers` (`lib/bundles.js`)
  always re-reads each `bunnyshare:<token>` live, so the bundle page can
  never show stale status; there is exactly one source of truth for a
  share's state (invariant 1 still holds).
- **One bundle per email, not per call (widened same day):**
  `findOrExtendBundle` (`lib/bundles.js`) looks for an existing, still-active
  bundle whose `email` matches (normalized) before creating a new one. If
  found, it appends the new members' tokens and extends `expiresAt` to the
  later of the two — so a recipient shared with across several separate
  admin actions (single share today, bulk share next week) keeps exactly ONE
  bundle page/link for their entire relationship with this deployment,
  rather than accumulating a new bundle every time. If NOT found (first time
  this email has ever been shared with, or their prior bundle expired), it
  also sweeps in any other still-active `bunnyshare:*` records for that
  email not already claimed by another bundle (e.g. single-video shares made
  before this widening existed) — so the first bundle for someone reflects
  everything currently shared with them, not just what's new. `/api/share.js`
  now always calls this too: a recipient's first share still gets the plain
  single-video email (`sendShareEmail`), but the moment they have more than
  one active share (from ANY endpoint, in ANY order), every subsequent
  notification uses `getBundleItems` to build ONE consolidated email
  (`sendBulkShareEmail`) listing everything currently active for them,
  instead of firing a new standalone email per share. This is a policy
  choice, not a security property: the effect is "recipient's active shares
  converge to one bundle and one running conversation," which is what was
  asked for ("if they are the same email, they should be in the same
  email").
- **Bundle gate is a second application of the same mechanism, not a bypass**:
  the bundle page is gated by the identical stateless-HMAC magic-link
  mechanism (section 2.2), scoped to a `bundle:<id>` pseudo-token that can
  never collide with a real 32-hex video token. The one difference from a
  single-video gate: on successful verification, the exchange mints not only
  a `gate_bundle_<id>` cookie (Path=`/bundle/<id>`) but also a `gate_<token>`
  cookie for EVERY member (Path=`/watch/<token>`, same format the per-video
  gate already produces) — this is the bundle's actual value (one
  verification, not N), and it works by minting standard per-video cookies,
  not by changing what `/watch/[token].js` accepts. Every video still
  independently re-checks `revoked`/`expiresAt` on every render regardless of
  cookie presence (section 2.4/2.5) — a bundle cookie shortcuts the email
  round-trip, never the live status check.
- **What breaks**: Treating the bundle record as authoritative for a
  member's status (instead of re-reading `bunnyshare:<token>`) reintroduces
  the second-source-of-truth risk this design deliberately avoids. Any code
  path that reads `bundle.tokens` and does NOT re-fetch each `bunnyshare:`
  record before showing title/status is wrong. `findOrExtendBundle` reads
  both index sets (`SMEMBERS bunnybundle-index`/`bunnyshare-index`, not a
  `KEYS` scan as of 2026-07-22 — see roadmap item a) on every call where no
  active bundle is found yet for that email (the orphan sweep) — this is
  the hottest of the former KEYS-scan call sites, running on every single
  `/api/share`/`/api/share-bulk` call, which is exactly why it was included
  in that fix rather than left for later. Also note: if a recipient already
  unlocked a bundle (has a valid
  `gate_bundle_<id>` cookie) and a NEW share is later folded into that same
  bundle, the new video appears in the listing immediately but has no
  per-video `gate_<token>` cookie yet — no per-video cookies are minted
  outside a fresh grant exchange (section 2.3/5.2), so clicking it correctly
  falls back to that video's own email gate. Graceful degradation, not a
  bug.

### 2.7 Middleware negative-lookahead matcher is the sole admin auth boundary

- **Decision**: `middleware.js` applies HTTP Basic Auth
  (`ADMIN_USER`/`ADMIN_PASS`) with matcher
  `["/", "/api/((?!watch/|bundle/).*)"]` (`middleware.js:29-32`, widened
  2026-07-20 to add `bundle/`). That single regex is the entire admin/public
  split: `/` and every `/api/*` route are protected **except**
  `/api/watch/*` and `/api/bundle/*`; `/watch/*` and `/bundle/*` pages are
  never matched at all (Next only runs middleware on paths named in
  `matcher`).
- **Credential comparison (changed 2026-09-13, `5eb7245`)**: the compare is
  no longer `u === user && p === pass`. It is
  `timingSafeEqualStr` (`lib/safeCompare.js`) applied to both halves under
  `Promise.all`, so neither half short-circuits the other and a correct
  username with a wrong password costs the same as a wrong username. The
  implementation is a random-per-call double HMAC over WebCrypto, because
  middleware runs on the **Edge runtime** where `node:crypto`'s
  `timingSafeEqual` does not exist — if you ever move this check into a Node
  context, prefer the native primitive there rather than assuming this one
  is equivalent. A new explicit `if (auth && user && pass)` guard means
  unset env vars reject everyone (as before) AND the compare can never be
  handed a stringified `undefined` to match against. The 401 body and
  `WWW-Authenticate` challenge are byte-identical to before. Honest limit:
  the timing property is argued from construction and has NOT been measured
  on Edge.
- **Why**: One declarative boundary instead of per-route auth checks that
  someone will forget on the next route.
- **What breaks**: Any new admin API route is protected automatically — but
  any new **public** route must be carved out of the matcher or it silently
  401s for recipients. Conversely, naming an admin route under `/api/watch/`
  or `/api/bundle/` exposes it unauthenticated — those two prefixes must stay
  recipient-only, never grow an admin sub-route. Routes added 2026-09-13
  under each side: `/api/shares/export` and `/api/analytics` are ADMIN
  (covered automatically, no matcher change needed);
  `/api/watch/request-access` is PUBLIC by virtue of its `/api/watch/`
  prefix — which is exactly the rule above working as designed, and exactly
  why that prefix must never gain an admin route. Note (as of 2026-07-18): the
  Next 16 build warns that the `middleware` file convention is deprecated in
  favor of `proxy`; renaming is a behavior-affecting change — do not do it
  casually.

### 2.8 Revoke = flag; cleanup = the only deleter

- **Decision**: `/api/revoke` sets `record.revoked = true` and writes the
  record back — never deletes (`revokeOne`, `pages/api/revoke.js`).
  `/api/cleanup` is the only code path that deletes, and only records that
  are `revoked || expired` (`pages/api/cleanup.js:9-13`). `revokeOne` is
  idempotent: revoking an already-revoked record is a no-op success, not an
  error — the end state is identical either way. `/api/revoke-bulk` (added
  2026-07-21) applies `revokeOne` to a list of tokens, reporting
  `{succeeded, failures}` per token — same never-fail-the-whole-batch
  pattern as `resend-bulk`/`extend-bulk`.
- **Why**: Revocation stays reversible (flip the flag back by hand) and
  auditable (the record still shows who had access to what until cleanup
  runs). Separating "deny access" from "destroy evidence" means a fat-finger
  revoke is recoverable.
- **What breaks**: Making revoke delete destroys the audit trail and
  reversibility. Making cleanup delete non-expired, non-revoked records
  breaks live links (invariant 1). Making `revokeOne` error on an
  already-revoked record would make bulk revoke fragile — a batch containing
  one already-revoked token should still succeed for that token, not report
  a spurious failure.

### 2.8a Extend = mutate `expiresAt` in place; revoked blocks it (added 2026-07-21)

- **Decision**: `/api/share/extend` (`extendOne`, exported from
  `pages/api/share/extend.js`) takes `{token, hours}`, computes
  `Math.max(Date.now(), record.expiresAt) + hours*3600*1000`, and writes
  that back as the SAME record's `expiresAt` — same token, same `/watch/`
  URL, same `gate_<token>` cookie name/scope, nothing else changes. Rejects
  outright if `record.revoked` is true (`{error: "Cannot extend a revoked
  share"}`); does NOT reject an already-expired-but-not-revoked share — that
  is the primary use case ("this link died, give me a bit more time"), and
  the `Math.max(Date.now(), ...)` base means extending a long-dead share
  computes from now, not from a stale past timestamp that a small `hours`
  value could leave still in the past. `/api/share/extend-bulk` applies the
  same logic to a list of tokens independently
  (`{succeeded: [...], failures: [...]}`, same never-fail-the-whole-batch
  pattern as `/api/share/resend-bulk`). If the token belongs to a bundle,
  `extendBundleForToken` (`lib/bundles.js`) re-maxes that bundle's own
  `expiresAt` too, so the bundle listing doesn't expire before a member that
  now legitimately outlives it (one-way: it only ever grows the bundle's
  expiry, never shrinks it).
- **Why**: The only prior way to give a recipient more time was revoke +
  re-share, which mints a NEW token and breaks the existing link/bookmark —
  directly against the never-break-live-links rule. Extending in place is
  the compatible alternative: zero new fields, zero new KV entities, the
  token a recipient already has keeps working, just for longer.
- **What breaks**: Allowing extend on a REVOKED record would let this
  endpoint silently double as an "un-revoke," undermining the admin's
  deliberate access-denial decision (section 2.8) — that must stay a
  separate, explicit action if it's ever added, not a side effect of
  extending. Extend must never accept a negative or non-numeric `hours`
  (checked: `Number.isFinite(addMs) && addMs > 0`) — a negative value would
  let this endpoint be repurposed as a stealth-shorten, which is Revoke's
  job and should stay visible as such.

### 2.8b Raising a view cap = grant more, never forget (added 2026-09-13)

- **Decision**: `/api/share/allow-views` (`allowMoreViews`, mirrored in
  `allow-views-bulk.js`) sets `maxViews = Math.max(maxViews, viewCount) +
  views`. It NEVER touches `viewCount`.
- **Why**: `viewCount` is simultaneously the audit trail of how often a
  recipient opened the link and an input to the `/api/analytics` rollup.
  Resetting it to revive a share would silently corrupt both and destroy
  evidence — the same reasoning that makes Revoke a flag rather than a
  delete (2.8) and makes `setEmailFailed` clear to `undefined` rather than
  `false` (5.1). Raising the cap leaves the record readable as what it is.
- **What breaks**: a "reset views" action would make the analytics rollup
  and the per-share history lie, with no way to tell afterwards that it
  happened. Allowing this on a REVOKED share would let a quota change
  double as an un-revoke (the trap 2.8a already closes for Extend).
  Allowing it on an UNCAPPED share would mean an endpoint named "allow
  more" silently imposing a restriction — tightening access is always its
  own visible action here.

### 2.9 `deliver()` is the single email chokepoint; provider is config, not code

- **Decision**: All SIX senders route through one `deliver({to, subject,
  text, html})` (`lib/mailer.js`). Recipient-facing: `sendShareEmail`,
  `sendBulkShareEmail`, `sendMagicLinkEmail`, `sendBundleMagicLinkEmail`.
  Admin-facing (added 2026-09-13, `5eb7245`):
  `sendFirstPlayNotificationEmail`, `sendAccessRequestEmail` — both send to
  `adminNotifyAddress()` (`ADMIN_NOTIFY_EMAIL`, falling back to the
  configured from-address) and both interpolate recipient-controlled values
  (a typed email address, a Bunny video title), so they carry the same
  `escapeHtml` obligation as every template above them. If `RESEND_API_KEY` is set → Resend HTTP
  API; otherwise nodemailer SMTP (`secure` iff port 465). Callers never know
  which.
- **Why**: Provider swap = env-var change, zero code. Guards
  (`escapeHtml`, `isValidUrl` — incident `29fb9be`) sit in the senders, so
  every email passes them regardless of provider.
- **What breaks**: A sender that bypasses `deliver()` silently forks
  provider config and dodges future cross-cutting fixes (logging, retries).
  A new email that skips `escapeHtml`/`isValidUrl` reopens the XSS /
  host-header incident (invariant 2). Provider selection and deliverability
  theory: email-delivery-reference.

## 3. Security invariants

Numbered; do not weaken any of them. "Verify" is a one-liner you can run
from the repo root to confirm it still holds.

| # | Invariant | Verify it still holds |
|---|-----------|-----------------------|
| 1 | **Never break live links** (prime directive): existing tokens, `bunnyshare:*` key prefix, record field meanings, `/watch/<token>` URL shape, and `gate_<token>` cookie name/path keep working across all changes. (Cautionary tale: `30ecd7f` silently migrated `share:` → `bunnyshare:` and orphaned old records.) | `grep -rn "bunnyshare:" lib pages` — every KV access uses the prefix; `grep -rn "gate_" lib pages` — cookie name unchanged (the watch cookie moved to `lib/watchAccess.js` on 2026-09-13, so a `pages`-only grep now misses it). Best check: `npm test` — `tests/watchAccess.test.mjs` asserts the exact cookie string |
| 2 | All user-controlled strings in email HTML pass `escapeHtml`; all links pass `isValidUrl` (`lib/mailer.js:4-22`) | `grep -n "escapeHtml\|isValidUrl" lib/mailer.js` — present in every `send*` function |
| 3 | `baseUrl(req)` REQUIRES `SITE_URL` and fails loudly if unset (`lib/shares.js`) — never falls back to the request's Host header, which a client can spoof. (2026-07-22 fix for a CodeQL host-header-poisoning finding; see failure-archaeology for the incident.) | `grep -n "SITE_URL is not set" lib/shares.js` — throw present; `grep -n "req.headers.host" lib/shares.js` — expect NO match |
| 4 | `/api/watch/request-link`, `/api/bundle/request-link` AND `/api/watch/request-access` return an IDENTICAL 200 body for every outcome — invalid link/bundle, mismatched email, throttled, rate-limited, success, AND any unexpected runtime error (anti-enumeration) | `grep -n "genericOk" pages/api/watch/request-link.js pages/api/bundle/request-link.js pages/api/watch/request-access.js` — expect 1 definition + 6 `return genericOk()` sites in each (5 outcome branches + the catch block, plus the per-IP branch added 2026-09-13). Any NEW branch in any of these handlers must return `genericOk()` |
| 5 | `GATE_SECRET` has no default; the gate throws if unset (`lib/gate.js:14-22`) | `grep -n "throw" lib/gate.js` — inside `secret()` |
| 6 | Grant verification uses `crypto.timingSafeEqual`; grants are token-bound and expiring (`lib/gate.js:55,60-61`) | `grep -n "timingSafeEqual\|payload.t !== token\|payload.x" lib/gate.js` |
| 7 | Middleware matcher keeps `/api/watch/*` and `/api/bundle/*` public and everything else on the admin surface behind Basic Auth (plus an opt-in admin geo whitelist); `/watch/*` and `/bundle/*` stay out of the matcher | `grep -n "matcher" middleware.js` — exactly `["/", "/api/((?!watch/\|bundle/).*)"]` |
| 8 | Every share has its own token; bulk M recipients × N videos → M×N records, each independently revocable | `grep -n "createShareRecord" pages/api/share-bulk.js` — inside the per-recipient, per-video loops |
| 9 | Revoke flips `revoked: true`, never deletes; `pages/api/revoke-permanent.js` is the one EXPLICIT exception (requires the record already be revoked) plus `cleanup.js` (revoked-or-expired sweep) | `grep -n "kvDel" pages/api/*.js` — only `cleanup.js` and `revoke-permanent.js` match |
| 10 | A magic-link grant is spendable once: the cookie-setting exchange marks it via `lib/singleUse.js`, and a spent grant falls through to the SAME form as an expired one (added 2026-09-13). Never spend a grant on a path that does not set the cookie | `npm test` — `tests/watchAccess.test.mjs` asserts the replay is byte-identical to an invalid grant AND that no refused path ever asks for a spend. Also `grep -n "isGrantSpent\|markGrantSpent" "pages/watch/[token].js" "pages/bundle/[bundleId].js"` |
| 11 | Admin credentials are compared in constant time, both halves always evaluated (added 2026-09-13) | `grep -n "timingSafeEqualStr" middleware.js` — expect it in a `Promise.all`, NOT behind `&&`; a bare `u === user` means it regressed |

## 4. Known weak points — honest register

Open and documented as of 2026-07-18. None is a secret; all are deliberate
scope decisions or unfinished hardening. "Candidate-fix" items live in
`bunny-sharing-roadmap` (ranked menu) and, where gate-related, in
`bunny-sharing-email-gate-campaign`.

| Weak point | Severity | Status |
|------------|----------|--------|
| Single shared admin credential; no lockout; no named users | Medium (admin surface) | Partly addressed 2026-09-13 (`5eb7245`): the compare is now constant-time (section 2.7). The shared-credential half is still open — roadmap (d) |
| ~~`kvKeys` uses Redis `KEYS` — O(N) full scan~~ FIXED 2026-07-22: `bunnyshare-index`/`bunnybundle-index` SETs + `SMEMBERS` replace it everywhere except the one-time `/api/backfill-index` migration | N/A | Adopted (bunny-sharing-roadmap item a) |
| ~~Magic-link grant is NOT single-use~~ | — | FIXED 2026-09-13 (`5eb7245`), section 2.2's bounded exception. Not live-certified; degrades to the old replayable behaviour if KV errors, by design |
| ~~No per-IP rate limiting~~ | Low | FIXED 2026-09-13 (`5eb7245`): `gateip:<ip>`, 10/min, on both public request-link endpoints. Coarse and non-atomic ON PURPOSE — a spam dampener, not a boundary; it can undercount under concurrency and fails open on any error |
| No linter, no CI; tests exist but are unit-level only | Medium (process risk, not runtime risk) | Partly addressed 2026-09-13 (`5eb7245`): 50-case `node --test` suite. NO route-level, component-level, or live coverage, and nothing runs it automatically on push — bunny-sharing-validation-and-qa |
| Filtered/searched `/api/shares`, and `/api/analytics`, read EVERY share record per call | Low (cost/latency, not correctness) | Accepted by design — roadmap (m). The UNFILTERED listing became bounded 2026-09-13 via `bunnyshare-by-created`; filtering cannot use an index without a second source of truth, and a rollup legitimately needs every record |
| ~~A used-up `maxViews` share cannot be revived without a new token~~ | — | FIXED 2026-09-13: `/api/share/allow-views` raises the cap in place, same token (2.8b) |
| `share`/`share-bulk` store records BEFORE sending email; a send failure leaves a live record whose recipient never got the link | Low | Fixed 2026-07-20: failed sends are flagged (`emailFailed`/`emailError`, additive fields) instead of silently existing, and an admin "Resend" button re-sends and clears the flag — see section 5.1. Resend (`/api/share/resend`, `pages/api/share/resend.js` exporting `resendOne`) is not gated on `emailFailed` — any active share can be re-sent on demand, and `/api/share/resend-bulk` does the same for multiple selected shares in one call (admin selects rows via checkboxes in the shares table) |
| The email gate has NOT been exercised against live Resend + a real inbox + prod Bunny/KV | High (unproven core flow) | Open — THE campaign: bunny-sharing-email-gate-campaign |
| Revocation is not instant: an in-flight Bunny embed token stays valid up to 3600 s after revoke (section 2.5) | Low (bounded window, by design) | Accepted-for-now |
| `GATE_SECRET` rotation is all-or-nothing (section 2.2) | Low (operational footgun, not a vuln) | Accepted-for-now; document before any rotation |

## 5. Compatibility contract: exact formats

These formats are what invariant 1 protects. Changing any field name, key
prefix, encoding, or URL shape breaks links/sessions already in the wild.

### 5.1 Share record — KV key `bunnyshare:<token>`

Created in `lib/shares.js:12-27`; stored via `kvSet` as URI-encoded JSON
over the Upstash REST API (`lib/kv.js:19-22`).

| Field | Type | Value / meaning |
|-------|------|-----------------|
| `token` | string | 32 lowercase hex chars — `crypto.randomBytes(16).toString("hex")` |
| `videoId` | string | Bunny Stream video GUID |
| `videoTitle` | string | Display title; falls back to `videoId` if absent |
| `email` | string | Exactly ONE recipient address per record — `parseEmails` (lib/shares.js) splits comma/semicolon/whitespace-joined input at the API boundary and both share endpoints fan out one record per address. NOT normalized at write time; the gate normalizes at compare time and (for legacy records that stored a combined string — see failure-archaeology Episode 9) matches the typed address against any address found in the stored string |
| `createdAt` | number | Unix epoch **milliseconds** |
| `expiresAt` | number | Unix epoch **milliseconds**, set at creation to `Date.now() + (Number(hours) || 72) * 3600 * 1000` (default 72 h); mutable in place by `/api/share/extend` (section 2.8a, added 2026-07-21) — `Math.max(Date.now(), current) + hours*3600*1000` — never on a revoked record |
| `revoked` | boolean | `false` at creation; flipped to `true` by `/api/revoke`; never deleted except by `/api/cleanup` |
| `viewCount` | number (optional) | Authorized page renders. ADDITIVE (added after 5905bba): absent on older records — read as `record.viewCount \|\| 0`, never assume present |
| `firstViewedAt` | number (optional) | Unix ms of first authorized render; additive, may be absent |
| `lastViewedAt` | number (optional) | Unix ms of latest authorized render; additive, may be absent |

| `playCount` | number (optional) | Real playback starts reported by the player; additive |
| `firstPlayedAt` / `lastPlayedAt` | number (optional) | Unix ms; additive |
| `maxProgressPct` | number (optional) | Furthest playback progress 0-100, monotonic (server takes max) |
| `completedAt` | number (optional) | Unix ms of first `ended` event; additive |
| `emailFailed` | boolean (optional) | Set `true` by `share.js`/`share-bulk.js` when the notification email failed to send (record still created; link still live). Set via `setEmailFailed` (lib/shares.js), which stores `undefined` (dropped from JSON, not written as `false`) to clear it rather than leaving a stale flag — absence means "no known failure", not "definitely sent" |
| `emailError` | string (optional) | The failed send's error message, for the admin table tooltip; cleared alongside `emailFailed` |
| `watermark` | boolean (optional) | Per-share watermark override (added post-1.1.0). Stored ONLY when explicitly `true`/`false`; ABSENT means "inherit the global default". Read by `resolveWatermark` (lib/settings.js) on the authorized watch render. Additive — absent on all older records, which inherit exactly as before |
| `lastPositionSec` | number (optional) | Resume support (added post-1.1.0): furthest/most-recent playback position in seconds, written by `/api/watch/track` on the `position` event. Additive; last-writer-wins |
| `durationSec` | number (optional) | Video duration in seconds, reported alongside `lastPositionSec`; lets the watch page suppress a resume offer near the end. Additive |
| `maxViews` | number (optional) | Per-share cap on AUTHORIZED PAGE RENDERS (added 2026-09-13, `5eb7245`). Written ONLY when a positive integer was supplied — never `0`, which would read as "nobody may open this". Absent means unlimited, which is how every earlier record behaves. Enforced in `pages/watch/[token].js` beside revoked/expired, BEFORE the email gate, as `record.maxViews && (record.viewCount \|\| 0) >= record.maxViews`. It counts openings, not plays. Raised (never reset) by `/api/share/allow-views` — see 2.8b |
| `note` | string (optional) | Short admin-supplied message (added 2026-09-13, `5eb7245`), trimmed and capped at 500 chars by `normalizeNote` (lib/shares.js). Stored RAW, escaped at every render point (`escapeHtml` for email, React for the admin table) — never pre-escaped, so the stored value stays the literal text typed. Absent when blank |

View fields are written by `pages/watch/[token].js` only on the AUTHORIZED
branch (valid cookie grant → embed render) — never for the email form or a
magic-link exchange. Playback fields are written by `/api/watch/track`
(public route) from Player.js events the Bunny embed emits via postMessage;
the client listener lives in the watch page's `Player` component. Track
calls must carry a **tracking grant** — a normal token-bound grant, capped
at min(6 h, share expiry), signed during the authorized SSR render and
passed as a page prop (the gate cookie is Path-scoped + HttpOnly, so client
JS cannot present it; the tracking grant is the sanctioned bridge). This
means playback counters cannot be inflated without having passed the email
gate. Last-writer-wins on concurrent updates (accepted at this scale).
One record per recipient × video means views AND playback are attributable
per person. Note: Player.js event delivery from the Bunny embed is
code-complete but not yet observed live (campaign P3 item); if events never
arrive, view tracking still works and playback columns simply stay empty.

Second index (added 2026-09-13): `bunnyshare-by-created`, a SORTED SET of
the same tokens scored by `createdAt`. Purely additive — `bunnyshare-index`
keeps its name, shape and every call site. It exists so the unfiltered admin
listing can read one page by rank instead of fetching every record to sort
them. Both indexes are written together on create and removed together on
delete; a token in one but not the other is a bug, and the read path treats
a short ordered index as untrustworthy and falls back to the full read. That
fallback is load-bearing: a deployment that upgrades without running
`/api/backfill-index` must list its shares exactly as before, never an empty
table. See roadmap item (m) for the rejected alternatives and the known
deploy risk.

Auxiliary key: `gatethrottle:<token>` — value `1`, Upstash `EX=30`
(`pages/api/watch/request-link.js`). Ephemeral; not part of the
compatibility contract, but keep the name stable so in-flight throttles
survive a deploy.

Three more ephemeral namespaces were added 2026-09-13 (`5eb7245`). None is
part of the compatibility contract, all self-expire, and all are
best-effort — every one of them fails OPEN, so losing the store degrades
behaviour rather than blocking anyone:

| Key | Value / TTL | Written by | Purpose |
|---|---|---|---|
| `gateused:<sha256(grant)>` | `1`, TTL = the grant's own remaining life | `lib/singleUse.js`, from the grant exchange in both gate pages | Single-use magic links (section 2.2's bounded exception). Keyed by HASH, never the raw grant |
| `gateip:<ip>` | request count, `EX=60` | `lib/rateLimit.js`, from both public request-link endpoints | Per-IP dampener, 10/min. Non-atomic read-modify-write by design |
| `accessreq:<token>` | `1`, `EX=3600` | `pages/api/watch/request-access.js` | One access request per expired share per hour |
| `gatelog:<padded-ms>-<rand>` | the exchange entry, `EX=90 days` | `lib/gateLog.js`, from the exchange in both gate pages | Audit log of grant exchanges (2.4b). Indexed by `gatelog-index`; `cleanup.js` sweeps orphaned members |

### 5.1a Bundle record — KV key `bunnybundle:<bundleId>`

Created in `lib/bundles.js` (`createBundleRecord`, or `findOrExtendBundle`
which extends an existing one instead when found) by BOTH
`pages/api/share-bulk.js` and `pages/api/share.js` (widened 2026-07-20) —
one bundle per email that ever gets a share, kept alive and extended across
however many separate calls touch that email, not one bundle per call.

| Field | Type | Value / meaning |
|-------|------|-----------------|
| `id` | string | 32 lowercase hex chars — same generation as a share token, but a distinct KV namespace (`bunnybundle:`, never `bunnyshare:`) |
| `email` | string | The one recipient this bundle belongs to, as first typed (not normalized) — `findOrExtendBundle` matches with `normalizeEmail` for lookup, but never rewrites this field on an existing bundle |
| `tokens` | array of string | The member share tokens (`bunnyshare:<token>` keys); grows via `findOrExtendBundle` as more shares are created for this email; never shrinks (a revoked/expired member stays listed, just filtered out live by `getBundleMembers`/`getBundleItems`) |
| `createdAt` | number | Unix epoch milliseconds — set once, at first creation, never updated on extend |
| `expiresAt` | number | `Math.max(...members.map(m => m.expiresAt))` at creation; re-maxed whenever `findOrExtendBundle` adds new members (section 2.6), AND whenever `extendBundleForToken` (section 2.8a) is called after a single member's own `expiresAt` grows via `/api/share/extend` — two different call sites, same one-way-grows-only rule, ONLY EVER GROWS. Since it's a max, NOT every member is individually expired when `Date.now()` finally passes it — most will have expired earlier. This is why `expiresAt` alone is an insufficient retirement signal (see the `pages/api/cleanup.js` note two paragraphs down). |

Deliberately absent: `videoTitle`, `revoked`, any per-member status. A
bundle is a grouping list, not a share — `getBundleMembers` (`lib/bundles.js`)
re-fetches each `bunnyshare:<token>` on every render (see section 2.6); this
record must never be extended with a field that duplicates something a
member record already owns.

Auxiliary key: `bundlethrottle:<bundleId>` — same shape and purpose as
`gatethrottle:<token>` but for `/api/bundle/request-link.js`. Ephemeral.

`pages/api/cleanup.js` deletes `bunnybundle:*` records once EITHER
`Date.now() > record.expiresAt` OR none of `record.tokens` currently
resolves to a live (existing, unrevoked, unexpired) `bunnyshare:<token>`
record (added 2026-07-22, fixing a "stale bundle" gap: since `expiresAt`
only grows and has no `revoked` check of its own, revoking/permanently-
deleting every member left a fully live, gate-able bundle behind with
nothing left to show it, sometimes for a long time). This is the only code
path that deletes bundle records.

### 5.1b Settings record — KV key `bunnysettings:global` (added post-1.1.0)

A single global record holding app-level admin settings (`lib/settings.js`),
in its own namespace that never collides with `bunnyshare:*`/`bunnybundle:*`.
Read on every authorized watch render (for the watermark decision) and by the
admin `/api/settings` route (GET/POST) and `/api/video-watermark` route (POST,
sets one video's override), both behind the middleware matcher like any
non-`watch/`/`bundle/` API route. Fields: `watermarkDefault` (boolean),
`watermarkExemptEmails` (string[]), `watermarkExemptDomains` (string[]),
`geoWhitelistEnabled` / `adminGeoWhitelistEnabled` (booleans — runtime
toggles only; the country LISTS live in env vars, never here),
`notifyOnFirstPlay` (boolean, added 2026-09-13 `5eb7245` — emails
`ADMIN_NOTIFY_EMAIL` the first time a share is played; off by default and
inert without a notify address), and
`watermarkByVideo` (object, Bunny videoId → boolean — per-video overrides;
videos have no KV record of their own, so their override lives here; an absent
key means inherit). Absent record → `DEFAULTS` (watermark off, no exemptions,
empty map), so the app behaves exactly as pre-settings until an admin saves.
Not deleted by cleanup — it is configuration, not per-share data. The watermark
decision itself is `resolveWatermark({settings, recipientEmail, shareWatermark,
videoWatermark})`, most-specific-wins: exemption (email or domain) wins, then
the per-share `record.watermark` override, then the per-video override
(`getVideoWatermark(settings, videoId)`), then `watermarkDefault`. Note
`saveSettings` preserves `watermarkByVideo` when a patch omits it, so a Settings
-form save never clobbers per-video overrides set from the Videos grid (and vice
versa via `setVideoWatermark`).

### 5.2 Grant string — `lib/gate.js`

Format: `<body>.<sig>` where

- `body` = base64url of `JSON.stringify({ t, e, x })`
- `sig` = base64url of `HMAC-SHA256(body, GATE_SECRET)` (raw digest bytes)
- base64url here = standard base64 with `+`→`-`, `/`→`_`, trailing `=`
  stripped (`lib/gate.js:24-26`)

Payload fields:

| Field | Type | Meaning |
|-------|------|---------|
| `t` | string | share token this grant is bound to — OR, for a bundle grant, the literal string `bundle:<bundleId>` (`pages/api/bundle/request-link.js`, `pages/bundle/[bundleId].js`). `verifyGrant` does plain string equality on `t`, so a bundle grant can never verify against a real video token and vice versa — no schema change to `lib/gate.js` was needed to add bundles |
| `e` | string | recipient email, normalized (`trim().toLowerCase()`) |
| `x` | number | expiry, Unix epoch **milliseconds** |

Four instantiations, same format:

| | `t` | `x` (expiry) | Where it lives |
|---|---|---|---|
| Magic-link grant | `<token>` | `Date.now() + 15 min` | `?grant=` query param in the emailed link |
| Cookie grant | `<token>` | `record.expiresAt` (the share's own expiry) | cookie `gate_<token>` |
| Bundle magic-link grant | `bundle:<bundleId>` | `Date.now() + 15 min` | `?grant=` query param on `/bundle/<bundleId>` |
| Bundle cookie grant | `bundle:<bundleId>` | `bundle.expiresAt` | cookie `gate_bundle_<bundleId>` |

On a successful bundle grant exchange (`pages/bundle/[bundleId].js`), the
per-video **cookie grant** row above is minted for every member token too —
same format as a direct single-video gate exchange produces, just minted N
times in one response instead of once (see section 2.6).

Verification (`verifyGrant`, `lib/gate.js:47-66`): recompute HMAC,
`timingSafeEqual`, reject expired (`x`), reject wrong token (`t`), never
throw on malformed input — malformed returns `null`.

### 5.3 Cookie — built by `buildGateCookie()` in `lib/watchAccess.js`, applied by `pages/watch/[token].js`

```
gate_<token>=<urlencoded grant>; HttpOnly; Path=/watch/<token>; SameSite=Lax; Max-Age=<seconds until record.expiresAt>[; Secure]
```

`Secure` is appended when `x-forwarded-proto` is https, or `SITE_URL`
starts with `https` — the page computes that and passes it in as `secure`.

The bundle listing cookie follows the identical shape, scoped to the bundle
path instead (built by `buildBundleCookie()` in `lib/bundleAccess.js`, applied
by `pages/bundle/[bundleId].js`):

```
gate_bundle_<bundleId>=<urlencoded grant>; HttpOnly; Path=/bundle/<bundleId>; SameSite=Lax; Max-Age=<seconds until bundle.expiresAt>[; Secure]
```

Both cookie names are distinct (`gate_` vs `gate_bundle_`) and both use
distinct Path scopes, so there is no name or scope collision even though a
`bundleId` and a video `token` are both 32 lowercase hex chars.

### 5.4 URL shapes

| URL | Shape | Source |
|-----|-------|--------|
| Share link | `<baseUrl>/watch/<token>` | `lib/shares.js:28` |
| Magic link | `<baseUrl>/watch/<token>?grant=<urlencoded grant>` | `pages/api/watch/request-link.js:55` |
| Bundle link | `<baseUrl>/bundle/<bundleId>` | `lib/bundles.js` `createBundleRecord` |
| Bundle magic link | `<baseUrl>/bundle/<bundleId>?grant=<urlencoded grant>` | `pages/api/bundle/request-link.js` |
| Embed | `https://iframe.mediadelivery.net/embed/<BUNNY_LIBRARY_ID>/<videoId>?token=<sha256 hex>&expires=<unix seconds>` | `lib/bunny.js:64` |

`baseUrl(req)` = `SITE_URL`, always — it throws if unset. There is no Host
header fallback (removed 2026-07-22; see invariant 3 and failure-archaeology
for why the old fallback was itself the host-header-poisoning bug, not the
fix for one).

## When NOT to use this skill

- **Running, deploying, cron/cleanup operation, KV conventions in
  practice** → `bunny-sharing-run-and-operate`.
- **Bunny Stream signing math, the two token-auth schemes, embed/thumbnail
  anatomy** → `bunny-stream-reference`.
- **Resend vs SMTP mechanics, STARTTLS/465, SPF/DKIM, deliverability
  triage** → `email-delivery-reference`.
- **What happened historically and why (incident narratives)** →
  `bunny-sharing-failure-archaeology`.
- **Whether/how to make a change safely** → `bunny-sharing-change-control`
  (this skill tells you what must not break; that one tells you how to
  change things anyway).
- **Env-var catalog and from-scratch setup** → `bunny-sharing-env-and-setup`.

## Provenance and maintenance

Written 2026-07-18 against branch `claude/bulk-share-separate-links-auth-cblrle`
at commit `5905bba`, by direct reading of: `middleware.js`, `lib/gate.js`,
`lib/shares.js`, `lib/kv.js`, `lib/bunny.js`, `lib/mailer.js`,
`pages/watch/[token].js`, `pages/api/share.js`, `pages/api/share-bulk.js`,
`pages/api/watch/request-link.js`, `pages/api/shares.js`,
`pages/api/revoke.js`, `pages/api/cleanup.js`, `pages/api/videos.js`.
Sections 2.6, 2.7, 5.1a, 5.2-5.4 updated 2026-07-20 for the bundle feature
(`lib/bundles.js`, `pages/bundle/[bundleId].js`,
`pages/api/bundle/request-link.js`), verified live against a mock KV + mock
SMTP (see bunny-sharing-roadmap item h for the observation log). Section 2.6
and 5.1a updated again same day when bundles were widened from "one per
bulk-share call" to "one per email, extended across calls, including
single-share" (`findOrExtendBundle`, `getBundleItems` in `lib/bundles.js`;
`pages/api/share.js` now participates) — see bunny-sharing-roadmap item h's
follow-up entry for the observation log. Section 2.8a added 2026-07-21 for
the expiry-extend feature (`pages/api/share/extend.js`,
`pages/api/share/extend-bulk.js`, `extendBundleForToken` in
`lib/bundles.js`), verified live against the same mock KV/SMTP harness — see
bunny-sharing-roadmap item i. Section 2.8 updated 2026-07-21 for bulk revoke
(`pages/api/revoke-bulk.js`, `revokeOne` exported from `pages/api/revoke.js`)
— see bunny-sharing-roadmap item j.

Updated 2026-09-13 for the `5eb7245` batch: section 2.2 (the bounded
single-use exception to stateless grants), 2.3 (single-use in the grant
lifecycle), 2.7 (constant-time credential compare; the two new admin routes
and one new public route), 2.9 (six senders, two of them admin-facing),
section 3 invariants 4/10/11, section 4's weak-points register, 5.1
(`maxViews`, `note`), 5.1's auxiliary-key table (`gateused:`, `gateip:`,
`accessreq:`), and 5.1b (`notifyOnFirstPlay`). That batch is verified by
build, a 50-case unit suite, and invariant greps — NOT by a live pass and
NOT by route-level tests; see failure-archaeology Episode 12 for the
evidence-shape comparison against the July items.

Re-verify volatile facts before trusting them:

```bash
git log --oneline -3                                  # still at/after 5eb7245 (the 2026-09-13 batch)?
grep -n "matcher" middleware.js                        # section 2.7 / invariant 7 — expect (?!watch/|bundle/)
grep -n "MAGIC_LINK_TTL_MS\|THROTTLE_SECONDS" pages/api/watch/request-link.js   # section 2.3
grep -n "randomBytes\|expiresAt\|revoked" lib/shares.js                         # section 5.1
grep -n "b64url\|timingSafeEqual" lib/gate.js                                   # section 5.2
grep -n "Path=/watch" "pages/watch/[token].js"                                  # section 5.3
grep -n "generateEmbedUrl(record.videoId" "pages/watch/[token].js"              # section 2.5 (3600 s)
grep -n "RESEND_API_KEY" lib/mailer.js                                          # section 2.9
grep -n "bunnybundle:\|getBundleMembers" lib/bundles.js                         # section 2.6 / 5.1a
grep -n "gate_bundle_\|Path=/bundle" "pages/bundle/[bundleId].js"               # section 5.3 bundle cookie
grep -n "findOrExtendBundle" lib/bundles.js pages/api/share.js pages/api/share-bulk.js  # one-bundle-per-email widening
grep -n "extendOne\|Cannot extend a revoked" pages/api/share/extend.js         # section 2.8a
grep -n "extendBundleForToken" lib/bundles.js pages/api/share/extend.js        # bundle expiry propagation
grep -n "revokeOne" pages/api/revoke.js pages/api/revoke-bulk.js               # section 2.8 bulk revoke
grep -n "isGrantSpent\|markGrantSpent" "pages/watch/[token].js" "pages/bundle/[bundleId].js"  # section 2.2/2.3 single-use, invariant 10
grep -n "timingSafeEqualStr" middleware.js                                     # section 2.7, invariant 11
grep -n "allowRequestFromIp" pages/api/watch/request-link.js pages/api/bundle/request-link.js  # per-IP dampener
grep -n "maxViews" lib/shares.js "pages/watch/[token].js"                      # section 5.1 view cap
grep -n "gateused:\|gateip:\|accessreq:" lib pages                             # section 5.1 auxiliary keys
npm test                                                                        # expect 50+ passing (roadmap g)
```

If any grep comes back changed or empty, the contract has drifted: read the
file, update the relevant section here, and check whether an invariant was
weakened (if so, escalate per bunny-sharing-change-control).
