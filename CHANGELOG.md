# Changelog

Notable changes to this project, newest first. Grouped by date, since most
days below were their own batch of work rather than a discrete release.
Seven version tags mark points release notes were cut from this history:

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
