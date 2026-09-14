# Changelog

Notable changes to this project, newest first. Grouped by date, since most
days below were their own batch of work rather than a discrete release.
Nine version tags mark points release notes were cut from this history:

- **v1.8.0** — an opt-in query monitor / performance overlay for `/watch`,
  `/bundle`, and the admin page, toggled purely by the `QUERY_MONITOR` env
  var.
- **v1.7.0** — the viewer group picker from Bulk Share and the Private list
  extended to the single-video Share modal.
- **v1.6.0** — named viewer groups for Bulk Share and the Private list,
  per-collection sharing from the admin grid, and a fix for a layout bug
  that made the recipient email box unusable once a group existed.
- **v1.5.0** — a per-video private access list (YouTube-style invite list)
  with an optional notify-by-email toggle, an admin geo bypass list,
  index-set-backed listings/lookups (replacing full keyspace scans), and
  fixes for stale bundles, host header poisoning in email links, and three
  dependency CVEs.
- **v1.4.0** — env-var-based geo location whitelists for both recipient
  pages and the admin surface.
- **v1.3.0** — Delete permanently, Restore (un-revoke), persistent bundle
  links in the admin table, bulk revoke, extend a share's expiry, and one
  bundle per recipient across repeat shares.
- **v1.2.0** — the email watermark (layered global / per-share / per-video /
  exemption control), per-video analytics, and resume playback.
- **v1.1.0** — everything from 2026-07-18 through 2026-07-21 (bulk sharing,
  the email gate, bundle pages and consolidation, resend/extend/revoke and
  their bulk forms).
- **v1.0.0** — everything at and before 2026-07-06.

## Unreleased

### Added
- **Bunny library pagination** (`lib/bunny.js`). Both `listVideos()` and
  `listCollections()` now walk every page instead of sending one
  `itemsPerPage=100` request with no `page` param. A library with more than
  100 videos silently lost everything past the first page — video #101 never
  appeared in the admin grid and could not be shared at all. A library at or
  under one page makes exactly one request, as before, with identical order
  and shape. A `MAX_PAGES` stop guards against a malformed `totalItems`.
- **Single-use magic links** (`lib/singleUse.js`, both gate pages). A grant
  is marked spent — by SHA-256 fingerprint, never stored raw — at the moment
  it is exchanged for a cookie, with a TTL equal to its own remaining life.
  Replaying an intercepted or forwarded sign-in link inside its 15-minute
  window now fails, and fails *identically to an expired link*, so it reveals
  nothing. Only the cookie-setting exchange spends a grant, which is what
  keeps a mail-client prefetch from burning the link on a path that grants
  nothing. Best-effort by design: a store failure degrades to the previous
  replayable behaviour rather than locking out a valid recipient.
- **Per-IP rate limiting** on `/api/watch/request-link` and
  `/api/bundle/request-link` (`lib/rateLimit.js`). The existing throttle was
  per-share-token only, so nothing stopped one source spraying many tokens.
  Checked before any record lookup, so a spray costs one read rather than a
  full lookup plus a send. Over-limit returns the same `genericOk()` as every
  other branch — anti-enumeration (invariant 4) holds on this path too.
  Fails open on a missing IP or a store error.
- **Constant-time admin credential compare** (`lib/safeCompare.js`,
  `middleware.js`). Replaces `u === user && p === pass`, which short-circuited
  and leaked through timing both how much of each credential matched and
  whether the username was right. Middleware runs on the Edge runtime, where
  `node:crypto`'s `timingSafeEqual` is unavailable, so this uses a
  random-per-call double-HMAC over WebCrypto and compares fixed-length
  digests branch-free. Both halves are always evaluated. Unset credentials
  are now rejected explicitly, so the compare can never be handed a
  stringified `undefined`. The 401 challenge is byte-identical to before.
- **First automated tests** (`tests/`, `npm test`). 50 `node --test` cases
  over the gate crypto (round-trip, expiry, token binding, signature and
  payload tampering, malformed input, bundle/video token separation),
  single-use marking, per-IP limiting, Bunny pagination, watermark
  resolution order, recipient-email parsing, `SITE_URL` fail-loud, share
  status/filter/paging, the analytics rollup, and CSV formula-injection
  escaping. No env vars or
  network required. The app's source uses extensionless imports that Next
  resolves and plain Node does not, so the runner installs a small test-only
  resolver hook (`tests/register.mjs`) rather than rewriting every import
  across the codebase.
- **First-play notification.** Optionally emails the admin the first time a
  recipient actually plays a share, driven off the record's `firstPlayedAt`
  being absent, so it fires at most once per share ever — never per view.
  New `notifyOnFirstPlay` setting (off by default) and `ADMIN_NOTIFY_EMAIL`
  env var. Sent after the record write and fully swallowed on failure:
  `/api/watch/track` is fire-and-forget and must not fail because mail is
  down. Bounded by the existing tracking grant, an active share, and the
  never-played-before condition.
- **Per-share view limit.** New additive `maxViews` field, enforced in
  `pages/watch/[token].js` alongside revoked/expired so a spent link never
  reaches the email gate. Stored only when a positive integer is supplied —
  absent means unlimited, exactly how every pre-existing record behaves.
  Surfaced in both Share forms, in the Views column (`3× / 3`), and as a new
  "Used up" status in the admin table and the status filter.
- **Note to recipients.** New additive `note` field (trimmed, capped at 500
  characters) carried into the single and bulk notification emails as an
  opening block, escaped like every other interpolated value, and shown
  under the video title in the admin table.
- **Searchable, filterable, server-side-paged shares table.**
  `/api/shares` gains `status`, `q`, `page` and `pageSize`, backed by a new
  shared `lib/shareQuery.js` so the listing and the export can never disagree
  about what a filter selects. The response adds `total`, `page`, `pageCount`
  and `totalAll` alongside the unchanged `shares` array. Honest scope: this
  cuts response size and browser work, not the number of store reads —
  ordering and filtering both need fields inside the records, and there is no
  sorted index. That remains open.
- **CSV export** (`/api/shares/export`, `lib/csv.js`). Honours the same
  filters as the listing, never paginated. Cells beginning with `=`, `+`,
  `-`, `@`, tab or CR are prefixed as text so a video title or note can't
  execute as a formula when the export is opened. UTF-8 BOM for Excel.
  Admin-only via the existing matcher — no matcher change needed.
- **Server-side per-video analytics** (`/api/analytics`, `computeAnalytics`
  moved into `lib/shareQuery.js`). Required by the paging change above rather
  than wanted for its own sake: the rollup used to be computed in the browser
  from the full shares array, so once the table only held one page it would
  have silently reported "analytics for the latest 50 shares" while looking
  unchanged. Computing it server-side over every record keeps the number
  honest and keeps the rows out of the browser, which was the point of paging.
- **Access requests on expired links** (`/api/watch/request-access`). Turns
  the dead-end expired page into a recoverable path: the recipient asks for
  more time, the admin extends, and the original link keeps working.
  Deliberately narrow — expired only (never revoked), no free-text message
  from the requester, only sends on an address match, throttled per share per
  hour plus the per-IP cap, and uniform response on every branch.

- **Route-level test suite** (`tests/helpers/harness.mjs`,
  `tests/routes.*.test.mjs`). Takes the suite from 50 to 83 cases and closes
  the coverage gap the rest of this batch shipped with. One
  `globalThis.fetch` router stands in for BOTH the Upstash REST API and the
  Resend HTTP API — both are plain fetch clients, so no module mocking and
  still no new dependency — plus Next-style request/response doubles. Covers
  the two public sign-in endpoints (all outcome branches byte-identical, the
  per-IP cap actually stopping sends, per-IP bucket isolation, the per-share
  throttle, grant token-binding and TTL), the access-request endpoint
  (expired-only, match-only, never for a revoked share, hourly throttle, and
  that extra body fields never reach the admin's inbox), playback tracking
  (first play notifies exactly once ever, a mailer failure never fails the
  call, counters need a valid token-bound grant), and the admin surfaces
  (note and cap persistence and escaping, failed-send flagging, status
  filters, search, paging clamps, unpaged filtered CSV export with formula
  neutralization, analytics counting every share rather than one page).
  This is the first time the uniform-response invariant has been checked by
  byte-comparing the branches instead of counting greps.
- **Fixed a test that passed for the wrong reason.** The existing
  "rejects a tampered signature" case flipped the last base64url character
  of the signature. A 32-byte HMAC encodes to 43 characters whose last
  carries only 4 significant bits, so several distinct final characters
  decode to identical bytes; the tamper was frequently a no-op and
  `verifyGrant` was correctly accepting an untampered signature. It failed
  only when a run produced a signature ending in `A`, which is why it
  passed alone and failed in the full suite. Now tampers at the byte level
  and asserts the bytes actually changed, plus a new wrong-length case.

### Changed
- **The watch page's access decision moved out of JSX into
  `lib/watchAccess.js`** (roadmap item (r), watch half). Pure refactor: no
  behaviour change, no format change, no new field. `decideWatchAccess()`
  performs no I/O — the record, settings, cookies, geo verdict and `secure`
  flag are passed in, the spent-grant lookup arrives as an injected
  `isSpent` callback, and it returns a data description of what to do
  (`invalid` / `exchange` / `need-email` / `authorized`). The page gathers
  facts and applies effects, and now contains no access branching of its
  own. `cookieName()` and `buildGateCookie()` moved with it.

  The motivation was coverage, not tidiness: the page is a JSX file, plain
  Node cannot parse JSX, and this repo has no transform — so the single
  most security-critical path in the app was the only significant one with
  no automated test. It now has 19 cases, including the replay case that
  was previously the weakest link in the whole release.

  One consequence worth flagging: the cookie string is no longer built in
  the page, so the invariant grep that pointed there stopped matching. It
  was repointed at `lib/watchAccess.js` in the same change, and the cookie
  string is now additionally pinned by an exact-string assertion. A
  refactor that relocates a compatibility surface must relocate its guard
  in the same change, or the guard silently stops guarding.

- **The bundle page's access decision moved into `lib/bundleAccess.js`**
  (roadmap item (r), bundle half — a separate commit, since it is a
  separate change to the gate). Same no-I/O contract, with two injected
  callbacks rather than one: `isSpent` for single-use and `loadMembers` for
  the member records, injected rather than loaded up front so the member
  read still only happens on the paths that need it.

  This collapsed a real duplication. The bundle page had its own
  `videoCookieName()` and its own per-video cookie template — a second
  implementation of a compatibility surface. Both now come from
  `buildGateCookie()` in `lib/watchAccess.js`. The architecture contract has
  always claimed a bundle exchange mints "the same format the per-video gate
  already produces"; that claim was previously held up by two
  implementations happening to agree, and now holds by construction, with a
  test asserting byte-identity. There is exactly one definition of the
  `gate_<token>` cookie in the repo.

- **Raise a share's view cap** (`/api/share/allow-views`, plus a bulk form
  and a "+ Views" button beside Extend). Closes the administration gap that
  shipped alongside view caps in this same release: a "Used up" link had no
  recovery short of re-sharing, which mints a new token and breaks the
  recipient's existing link — the exact workflow Extend was added to
  eliminate.

  It RAISES the cap and never resets the count. That was the open design
  question, and it resolves the way everything else in this repo does:
  never destroy evidence. The view count is simultaneously the record of
  how often a recipient opened the link and an input to the analytics
  rollup, so zeroing it would quietly corrupt both. Raising the ceiling
  leaves the record readable as what it is, and the response reports both
  numbers.

  Two deliberate refusals, each mirroring existing policy: a REVOKED share
  is refused so a quota change can never double as an un-revoke, and an
  UNCAPPED share is refused because imposing a limit is a tightening of
  access, which in this codebase is always its own visible action rather
  than a surprise from an endpoint named "allow more". There is still no way
  to remove a cap or add one to an existing share; both are policy changes
  rather than grants and neither has been asked for.

- **Audit log of grant exchanges** (`lib/gateLog.js`, read at
  `/api/gate-log`). The last unbuilt item on the gate campaign's hardening
  menu apart from the deliberately-fenced OTP fallback. Every exchange of a
  magic-link grant for a viewing cookie, on either entrance, records when,
  which share, the IP, and a fingerprint of the verified email. Answers the
  question view counters cannot: who got in, when, and from where.

  Built close to the menu's sketch with three tightenings. The key carries a
  random suffix, because a bare timestamp collides when two exchanges land in
  the same millisecond and a colliding write silently destroys an audit
  entry. Entries expire after 90 days, because append-only-forever in this
  store has no retention story and would accumulate IP addresses
  indefinitely. Writes never throw, because a logging outage that blocks a
  legitimate sign-in is strictly worse than a gap in the log.

  The email is hashed rather than stored, as the menu specified: the share
  record already holds the address, so the log holds strictly LESS than the
  records it points at rather than becoming a second store of personal data
  under its own retention rule. `pages/api/cleanup.js` sweeps orphaned index
  members, the same self-healing it already does for shares and bundles.

  No admin-page UI, deliberately. Forensics is rare and investigative, and
  the dashboard is already dense; the runbook documents the curl.

- **A createdAt-ordered share index, so the default admin listing reads one
  page instead of every record** (roadmap item (m)). New
  `bunnyshare-by-created` sorted set written alongside the existing index and
  removed alongside it; `/api/shares` serves the unfiltered listing from it
  and keeps the previous full read for filtered and searched queries.

  The design question that entry flagged was what filters do once paging
  happens in the store, and it was settled in writing before any code. Two
  options were rejected for stated reasons: paging the ordered set and then
  filtering within the page would make the "N of M" count lie, and per-status
  indexes are impossible to keep true because a share becomes expired when
  the clock passes, with no write to hook an update onto — that index could
  only be maintained by a sweeper and would be a second source of truth
  between sweeps.

  The load-bearing part is the fallback. A deployment that upgrades without
  running "Rebuild index" has no ordered index, and an ordered index that is
  absent, short, or rejected by the store all degrade to the previous full
  read and still list every share. An empty admin table on upgrade would have
  been the 30ecd7f silent-migration failure repeating. Rebuilding the index
  is a performance opt-in, never a correctness dependency.

  Known risk recorded rather than papered over: the store's REST command
  shape for sorted sets cannot be verified in this environment, because the
  tests run against an in-memory double that assumes the same shape the code
  does. The fallback is what makes that survivable — if the commands are
  rejected, the listing behaves exactly as it does today. Verify on deploy;
  a listing that always falls back after a successful rebuild is the expected
  failure signature.

### Fixed
- **Two CodeQL "incomplete URL substring sanitization" alerts on the gate
  route tests, fixed by strengthening the assertion rather than dismissing
  the finding.** Both were test-scope, so nothing in production depended on
  them, but the assertion really was weak for its own subject:
  `body.includes("https://videos.test/watch/")` passes for a body carrying
  `https://evil.example.com/x?next=https://videos.test/watch/abc` — the
  exact host-header-poisoning shape that test exists to guard against, so it
  could have been green while the property it claimed was violated. Every
  absolute URL in the body is now extracted and its parsed host asserted,
  plus the link's origin and path checked exactly.

  A companion test pins that the replacement is real: it asserts the old
  substring check passes the poisoned body and the new parsed check rejects
  it. This is the second test in this release found green for the wrong
  reason, after the base64url tamper case, so the general rule is now
  recorded in the project skills — when a test claims to reject something,
  prove it rejects it.

### Verified
- `npm run build` clean; all new routes register (`/api/shares/export`,
  `/api/watch/request-access`, `/api/analytics`), `Proxy (Middleware)` still registers with the
  async middleware.
- `npm test` — 152/152 passing, stable across repeated runs (the base64url
  flake above was found this way). The view-cap round trip is proven end to
  end: a used-up share refused by the real access decision, the cap raised
  through the real route, and the SAME token then passing the gate.
- **Compatibility evidence for the watch-page extraction** (change-control
  class (c)): a record carrying ONLY the original 2026-07 fields — no
  `viewCount`, `watermark`, `maxViews`, `note`, `lastPositionSec` or
  `durationSec` — still reaches the email gate, still accepts a magic link,
  and still plays with a cookie, starting its view tracking cleanly. The
  cookie name, `Path` scope, `HttpOnly`, `SameSite` and the full string are
  asserted verbatim. The grant format and `lib/gate.js` are untouched, so
  magic links and cookies signed before this change verify after it.
- Invariant greps re-run: matcher unchanged
  (`["/", "/api/((?!watch/|bundle/).*)"]`), `bunnyshare:` prefix unchanged
  with no bare `share:` keys, `gate_<token>` cookie name and
  `Path=/watch/<token>` unchanged, `SITE_URL` fail-loud with no Host-header
  fallback, `timingSafeEqual` and the fail-loud `GATE_SECRET` still present
  in `lib/gate.js`, `escapeHtml`/`isValidUrl` applied in every mail template
  including the two new admin ones, revoke still flag-only with no `kvDel`,
  `kvDel` still confined to `cleanup.js` and `revoke-permanent.js`, and
  `kvKeys` still confined to `backfill-index.js`.
- Every new record field (`maxViews`, `note`) is additive and optional;
  no existing field was renamed or changed meaning, and no KV key prefix
  moved.

### Not yet exercised
- No live pass against real Resend/Bunny/KV for any of the above. The per-IP
  limiter, the first-play notification and the access-request flow are now
  covered by route tests against in-memory doubles, but doubles are not
  services.
- **The single-use exchange is now tested on both gate entrances** — the
  replay is asserted byte-identical to both an invalid and an expired grant,
  and no refused path ever spends a grant, on the watch page and the bundle
  page alike. It has still never been observed on a real deployment.
- What remains untested is presentational: React components, including the
  Analytics panel whose near-miss is recorded in the project skills, and the
  player's postMessage tracking. Covering those needs a JSX transform and
  therefore a new dependency, which this repo has consistently avoided.
- Bunny pagination is verified against a stubbed API that reports
  `totalItems`, not against a real library of more than 100 videos.
- The constant-time compare has not been measured for timing behaviour on
  Vercel's Edge runtime; it is argued from construction, not benchmarked.

## v1.8.0 — 2026-07-30

### Added
- **Query monitor / performance overlay**, toggled purely by the
  `QUERY_MONITOR` env var (like WordPress's Query Monitor /
  wp-memory-usage). New `lib/monitor.js` uses `AsyncLocalStorage` to give
  each request its own fresh store — nothing is cached at module scope, so
  numbers can never freeze on the first page load the way a prior
  implementation did. `lib/kv.js`'s single `kvFetch` chokepoint records
  every KV call's op/key/timing for free across the whole app. `/watch` and
  `/bundle` pages (SSR) render a bottom-left overlay
  (`components/QueryMonitorBar.js`) with per-request query count, timings,
  total time, and memory. Every `/api/*` route is wrapped with
  `lib/withMonitor.js`, which attaches an `X-Query-Monitor` response header
  when enabled (no-op, zero overhead when off). The admin page shows a
  bottom-right badge (`components/QueryMonitorPanel.js`) reading the new
  `/api/monitor-status` route for ON/OFF, and a live per-page-load tally of
  its own API calls collected from that header via a small `window.fetch`
  patch (`lib/clientMonitorStore.js`) — module state that resets on every
  full page load.

## v1.7.0 — 2026-07-29

### Added
- **Viewer group picker in the single-video Share modal.** The
  "+ Add group..." picker already existed in Bulk Share and the Private
  list; the regular per-video Share button lacked it, forcing recipients
  in a named group to be retyped one at a time. Reuses the existing
  `mergeGroupIntoEmails` helper and the same email input — no API changes.

## v1.6.0 — 2026-07-26

### Added
- **Named viewer groups.** Labelled, admin-editable lists of emails (e.g.
  "Team A") that can be inserted into Bulk Share or a video's Private list
  instead of retyping the same recipients every time. New `lib/groups.js`
  (`bunnygroup:<id>` KV record — `{id, name, emails[], createdAt,
  updatedAt}` — plus a `bunnygroup-index` set) and CRUD routes `/api/groups`
  (GET list / POST create) and `/api/groups/[groupId]` (GET / PUT / DELETE).
  `/api/share-bulk` and `/api/video-invite` accept an optional `groupIds`
  array and resolve it (`resolveGroupEmails`) into the recipient list
  alongside typed emails. A group only supplies emails — it grants no
  access itself, so editing or deleting a group never touches shares
  already created from its members. Managed from a new "👥 Viewer groups"
  panel on the admin page, with quick "+ Add group..." pickers in the Bulk
  Share bar and the Private list modal.
- **Per-collection sharing.** `listVideos()` now includes each video's
  Bunny `collectionId`, and a new `listCollections()` fetches the
  library's collection list (name + video count) from the Bunny Stream
  API; `/api/videos` returns both as `{ videos, collections }` (the
  collections fetch is non-fatal — a failure there still returns videos
  rather than 500ing the whole admin grid). The admin page shows a row of
  collection buttons above the video grid ("📁 Team Offsite (12)"); clicking
  one adds every video in that collection to the current selection, which
  feeds directly into the existing Bulk Share bar — no separate sharing
  path, just a shortcut into the one that already exists.

### Fixed
- **Group-picker dropdown crushing the recipient email input.** The bare
  `<select>` for "+ Add group..." (Bulk Share bar and Private list modal)
  had no explicit width, so it inherited the global `select { width: 100% }`
  rule and competed with the adjacent email `<input>` for space in an
  unwrapped flex row — squeezing the input down to a near-invisible sliver
  that looked like a stray checkbox, and making it impossible to type
  emails once a group existed. The dropdown resetting to "+ Add group..."
  after each pick is intentional (a one-shot "add this group's emails"
  action, not a persistent selection) — only the crushed input was a bug.
  Fixed by giving the dropdown a fixed auto width and the input a real
  minimum width so both stay usable side by side.

## v1.5.0 — 2026-07-25

### Added
- **Private access list per video.** A YouTube-style "share privately with
  a list of people" feature, on top of the existing Share/Bulk Share flows.
  Each video gets a "Private list" button opening a persistent, editable
  invite list (`lib/invites.js`, `bunnyinvite:<videoId>` KV record —
  `{videoId, videoTitle, members: [{email, token, addedAt}]}`). Adding
  emails only creates a share + sends the notification email for the ones
  not already on that video's list (same `createShareRecord`/
  `findOrExtendBundle`/`sendShareEmail` path as `/api/share`); emails
  already on the list are untouched — no duplicate record, no re-sent
  email. Removing an email revokes its underlying share immediately (flag,
  never delete — same as `/api/revoke`) and drops it from the list;
  re-inviting that email later is a fresh invite. New routes:
  `/api/video-invite` (GET list with live per-member status / POST add
  emails) and `/api/video-invite/remove` (POST remove one email), both
  behind the existing admin Basic Auth matcher. The list itself is purely a
  membership record — status is always read live from each member's own
  `bunnyshare:<token>`, never duplicated, so it can't go stale. The add form
  also has a **"Notify new people by email"** checkbox (on by default,
  matching Google Drive/YouTube's own sharing dialogs) — unchecking it still
  creates a fully live share for each newly added email, it just skips the
  notification send (`addInvitees({..., notify: false})`).
- **Admin geo bypass list.** `ADMIN_GEO_BYPASS_EMAILS` lists Basic Auth
  usernames (case-insensitive) that always skip the admin geo check,
  regardless of country or the enforcement toggle — checked first, with no
  KV lookup. Same env-var-only, read-only-in-Settings pattern as the geo
  whitelists themselves. Meant to be armed **before** traveling, not used
  to escape a lockout after the fact: env var changes need a redeploy.

### Changed
- **Replaced KEYS scans with index sets.** The admin shares listing, bundle
  lookups, and cleanup used to scan the ENTIRE Redis keyspace with `KEYS
  bunnyshare:*`/`KEYS bunnybundle:*` on every load — expensive and blocking
  as the store grows, and not scoped to just this app's keys. Two new
  Redis SETs, `bunnyshare-index` and `bunnybundle-index`
  (`lib/shares.js`/`lib/bundles.js`), are now maintained alongside every
  create/delete (best-effort SADD on create — never blocks share/bundle
  creation if it fails; SREM on delete, in `revoke-permanent.js` and
  `cleanup.js`) and read via `SMEMBERS` instead. Every KEYS-scanning call
  site was updated: `/api/shares`, `/api/cleanup`, and three functions in
  `lib/bundles.js` (`findOrExtendBundle`'s orphan sweep,
  `bundleLinksForTokens`, `extendBundleForToken`) — the last three matter
  more than the admin listing itself, since `findOrExtendBundle` runs on
  every single `/api/share`/`/api/share-bulk` call, not just page loads.
  New one-time migration endpoint `/api/backfill-index` (idempotent, also
  in the admin UI as "🔁 Rebuild index") populates both indexes from a
  real scan for records that existed before the index did — required once
  after upgrading an existing deployment; not needed on a fresh one.
  Cleanup also now self-heals any orphaned index entries (a token/id
  present in the index whose record is already gone) it happens to notice.
  Verified live against a mock Upstash REST server: created shares, listed
  them via the new index path, permanently deleted one and confirmed its
  index entry was removed, injected a raw "pre-existing" record bypassing
  the index and confirmed it was invisible until `/api/backfill-index` was
  run (then present, and idempotent on a second run), and confirmed
  cleanup both deletes real expired records and silently drops an injected
  orphan index entry without miscounting it as deleted.
- **UI polish pass** across the admin, watch, and bundle pages: hover/focus
  states, a real overlay modal for the share form, status pills, and
  striped/scrollable tables. Cosmetic only — no fetch calls, payloads, or
  auth logic touched.

### Fixed
- **Stale bundles.** `/api/cleanup` used to retire a bundle only once its
  own `expiresAt` passed — but a bundle has no `revoked` flag, and its
  `expiresAt` tracks the MAX of every member ever added (only growing, via
  Extend), so revoking or permanently deleting every video in a bundle
  left a fully live, gate-able bundle record behind with nothing left to
  show, potentially for a long time. Cleanup now also retires a bundle the
  moment none of its listed members are live (revoked, expired, or
  deleted) anymore, regardless of the bundle's own expiry. Verified live
  against a mock KV store: bulk-shared 2 videos into one bundle with a
  ~1-year expiry, revoked and permanently deleted both members, confirmed
  the bundle record was untouched by that alone, then ran cleanup and
  confirmed it was removed (from KV and its index) despite being nowhere
  near its own expiry.
- **Host header poisoning in email links (CodeQL critical, alerts #5/#6).**
  `baseUrl()` (`lib/shares.js`) used to fall back to the request's `Host`
  header — client-suppliable — whenever `SITE_URL` was unset, letting a
  forged request make the app email real recipients a legitimate-looking
  notification pointing at an attacker's domain. The 2026-07-10 XSS fix
  (`escapeHtml`/`isValidUrl`) never covered this — `isValidUrl` only checks
  a link is well-formed `http(s)`, not that the host is actually this app.
  `SITE_URL` is now required; `baseUrl()` throws if it's unset, same
  fail-loud pattern as `GATE_SECRET`, with no Host-header fallback at all.
  Also hardened the two public gate endpoints
  (`/api/watch/request-link`, `/api/bundle/request-link`): their `catch`
  blocks used to return a distinguishable 500 on any thrown error, but that
  only ever fires on the path where the email already matched — so a
  missing `SITE_URL`/`GATE_SECRET` would otherwise become a live oracle for
  valid token+email pairs. Both now fold into the same `genericOk()`
  response as every other outcome. (A related CodeQL alert, #7, "polynomial
  regex" on `lib/gate.js`, was investigated and found to be a false
  positive — benchmarked linear from 1K to 1M-char inputs — no code change.)
- **Upgraded `next` 16.2.10 → 16.2.11**, patching a middleware/proxy-bypass
  advisory (GHSA-6gpp-xcg3-4w24) and a Server Actions denial-of-service
  advisory (GHSA-m99w-x7hq-7vfj), both flagged high-severity. Straight
  patch-version bump, no code changes needed — same remediation style as
  the 2026-07-10 CVE sweep. Particularly relevant here since `middleware.js`
  now carries two geo-whitelist gates added this same day.
- **Pinned `sharp` to `^0.35.3` via a new `overrides` entry**, patching
  four libvips CVEs (CVE-2026-33327/33328/35590/35591), also flagged
  high-severity. `sharp` is a transitive, optional dependency of `next`
  used only by `next/image`, which this app never imports (thumbnails are
  plain `<img>` tags) — so the vulnerable code path was never reachable,
  but pinning is cheap and removes the alert outright rather than leaving
  it open. Same technique as the existing `postcss` override from the
  2026-07-10 CVE sweep: force the transitive dependency to a patched
  version without touching `next` itself. `npm audit` now reports zero
  vulnerabilities.

## v1.2.0 — 2026-07-21

### Added
- **Email watermark on the player.** The verified recipient's email can be
  overlaid across the video (tiled, plus one drifting copy so a fixed crop
  can't remove every instance) to deter casual re-sharing and attribute a
  leaked screen-recording to one person. Layered control: a global default
  (admin Settings panel), a per-share Always/Never override (single + bulk
  Share forms), a per-video Always/Never override (select on each Videos row),
  and an exemption list of emails/domains that are never watermarked (e.g.
  internal admins/reviewers). Resolution order is exemption → per-share →
  per-video → global default. Honest limit: it's a client-side overlay over the cross-origin
  player, not burned into the video pixels — it raises effort and attributes
  leaks, it is not DRM.
- **Per-video analytics.** A collapsible admin panel rolls the existing
  per-share tracking (views, plays, completion, furthest progress) up per
  video — shares, unique recipients, total views, started, completed +
  completion rate, and average progress. Reads only fields already stored; no
  new tracking was added for it.
- **Resume playback.** A returning viewer who left a video partway is offered
  "Resume from m:ss" (or Start over). The player reports a throttled playback
  position while watching; the watch page seeks to it on request. Skipped when
  the saved point is basically the end.
- **Global settings store.** First app-level settings, in a new
  `bunnysettings:global` KV namespace, edited from a Settings panel on the
  admin page and read/written via the admin-only `/api/settings` route.

## v1.4.0 — 2026-07-22

### Added
- **Geo location whitelists (recipient + admin), both env-var-based.** Two
  independent country whitelists, same design: `/watch` and `/bundle` pages
  can be restricted via `GEO_WHITELIST`; the admin page and its API routes
  can be restricted via `ADMIN_GEO_WHITELIST`, on top of Basic Auth. Both
  lists live ONLY in env vars, never in the admin-editable Settings
  record — the Settings panel just has an ON/OFF toggle for each (off by
  default) and a read-only display of what's configured, so a bad list is
  always recoverable from the hosting dashboard, never trapped behind a
  page it's blocking. Detected via Vercel's edge network
  (`x-vercel-ip-country`); both fail open (never block) when that header
  is absent, so a non-Vercel deployment or local dev is simply
  unrestricted rather than silently locked out. A coarse IP-geolocation
  signal, not identity verification — complements the email gate/admin
  credentials rather than replacing them.

## v1.3.0 — 2026-07-22

### Added
- **Delete permanently.** A revoked share can now be deleted outright from
  the admin table — the same deletion `/api/cleanup` already does in bulk
  for revoked/expired records, just on demand for one link via the new
  `/api/revoke-permanent` route. Only allowed once a share is already
  revoked (no one-click delete from Active), so it's always a deliberate
  second step after Revoke, and it makes Restore impossible afterward —
  the record is gone, not just flagged.
- **Restore (un-revoke).** A revoked share can be flipped back to active from
  the admin table — same token, URL, and cookie as before. New `/api/unrevoke`
  route (admin-only), idempotent like Revoke, and kept as its own explicit
  action rather than folded into Extend (which still refuses revoked shares
  outright). Restoring an already-expired share brings back "Expired," not a
  working link — pair with Extend if the recipient still needs access.
- **Persistent bundle links in the admin table.** Every share belonging to a
  bundle now shows a link to its bundle page directly in the shares table
  (`/api/shares` looks up each token's bundle in one scan and attaches the
  link), instead of the link only ever appearing once in the toast shown
  right after sharing.
- **Bulk revoke.** Select multiple shares in the admin table and revoke them
  all in one action; each link's outcome is reported independently so one
  bad token never blocks the rest. Revoke is now idempotent — revoking an
  already-revoked share succeeds instead of erroring.
- **Extend a share's expiry.** Give a recipient more time without breaking
  their existing link — same token, same URL, same cookie, just a longer
  `expiresAt`. Works even on an already-expired (but not revoked) share,
  extending from now rather than the stale old expiry. Refuses outright to
  extend a revoked share, so it can never double as a silent "un-revoke."
  Bulk form included. If the share belongs to a bundle (see below), the
  bundle's own expiry is extended to match.
- **One bundle per recipient, not one per action.** Repeat shares to the
  same email address — from the single-share or bulk-share flow, in any
  order, at any time — now land in the SAME bundle and consolidate into ONE
  notification email listing everything currently active for that person,
  instead of piling up a new standalone email every time.

## 2026-07-20

### Added
- **Bundle listing page.** A bulk-shared recipient gets one gated page
  (`/bundle/<id>`) listing every video shared with them, alongside — not
  instead of — their individual per-video links. One email verification
  unlocks the whole bundle: it mints a bundle cookie for the listing page
  plus a standard per-video cookie for every member, so clicking through
  plays immediately. Each video still independently enforces its own
  revoke/expiry regardless of the bundle cookie.
- **Email-send failure handling.** A failed notification email no longer
  leaves an invisible "ghost" share — the link still exists, but it's now
  flagged (`emailFailed`, with the error) and shown with a "⚠ email failed"
  badge in the admin table.
- **Resend**, generalized beyond failure recovery: any active share's
  notification can be resent on demand (not only flagged ones), plus a bulk
  "Resend N" action for multiple selected shares.
- Project skill library added under `.claude/skills/` documenting the
  architecture, the email-gate design, the operating runbook, a debugging
  playbook, and the roadmap, for AI-assisted maintenance of this repo.

## 2026-07-19

### Fixed
- Comma-separated recipient emails typed into a single field were stored as
  one combined string instead of fanning out to separate records. This
  silently broke the magic-link gate (a typed address never matched the
  combined string) and caused every recipient in that batch to receive the
  identical link instead of their own. All recipient parsing now goes
  through one `parseEmails()` choke point; already-affected legacy records
  are still matched correctly at the gate as a compatibility repair.

## 2026-07-18

### Added
- **Bulk sharing.** Select multiple videos and share them to multiple
  recipients in one action. Every recipient × video pair gets its own
  independently revocable link — never a link shared between people.
- **Email-gated access.** A recipient must type the email address the link
  was shared with; only on a match does the app email a one-time sign-in
  link. The response is identical whether the email matched, didn't match,
  or the link doesn't exist, so the gate can't be used to probe which
  address a link belongs to.
- **Per-link tracking**: view counts (page opens) and real playback tracking
  (play, 25/50/75/100% progress, via the video player's own events) —
  tracked separately, so "opened the page" and "actually watched it" are
  distinguishable per recipient.
- Resend's HTTP API added as the primary email delivery path, with
  automatic fallback to SMTP if it isn't configured.

## 2026-07-14

### Fixed
- Video thumbnails returning 403 once the CDN pull zone's Token
  Authentication was enabled. Thumbnails need their own signing key,
  distinct from the one used to sign embedded-player URLs — the two had
  been conflated.

## 2026-07-10

### Fixed
- XSS and host-header poisoning in generated share emails (unescaped
  title/link interpolation; the link's origin was trusted from request
  headers without validation).
- Upgraded dependencies to patch known vulnerabilities.

### Removed
- Two CI security-scanner workflows were added and removed again the same
  day — not part of this project's actual CI/deployment setup.

## 2026-07-06

### Added
- Project README.

## 2026-07-03

### Changed
- Reverted the previous day's per-send SMTP `verify()` call, extra env
  validation, and verbose logging — it doubled the round-trip time of every
  send and logged recipient addresses to the console. A one-off,
  on-demand verification check replaced it for diagnostics instead.

### Added
- Link column in the admin shares table.

### Fixed
- The KV key prefix was silently renamed from `share:` to `bunnyshare:` with
  no data migration, orphaning every share created before the change. This
  incident is the origin of the project's standing "never break live links"
  rule for all later work.

## 2026-07-02

### Added
- Initial version: single-recipient share links, video listing from Bunny
  Stream, SMTP email delivery.
