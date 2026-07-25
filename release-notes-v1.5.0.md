## v1.5.0

A per-video private access list (YouTube-style invite list), an admin geo
bypass list, index-set-backed listings/lookups, and three security/CVE
fixes. All additive — existing share tokens, `/watch` links, gate cookies,
and KV records keep working unchanged.

### Added
- **Private access list per video.** A YouTube-style "share privately with
  a list of people" feature, on top of the existing Share/Bulk Share flows.
  Each video gets a "Private list" button opening a persistent, editable
  invite list. Adding emails only creates a share and sends the
  notification email for the ones not already on that video's list —
  emails already on the list are untouched, no duplicate record, no
  re-sent email. Removing an email revokes its share immediately (flag,
  never delete, same as Revoke) and drops it from the list; re-inviting
  that email later is a fresh invite. A **"Notify new people by email"**
  checkbox (on by default, matching Google Drive/YouTube's own sharing
  dialogs) controls whether each newly added person actually gets emailed —
  their share is created and live either way.
- **Admin geo bypass list.** `ADMIN_GEO_BYPASS_EMAILS` lists Basic Auth
  usernames that always skip the admin geo check, regardless of country or
  the enforcement toggle. Meant to be armed before traveling, not used to
  escape a lockout after the fact.

### Changed
- **Replaced full-keyspace `KEYS` scans with index sets.** The admin shares
  listing, bundle lookups, and cleanup used to scan the entire Redis
  keyspace on every load. Two new Redis SETs (`bunnyshare-index`,
  `bunnybundle-index`) are now maintained alongside every create/delete and
  read via `SMEMBERS` instead — including `findOrExtendBundle`'s bundle
  lookup, which runs on every single share/bulk-share/invite call. A new
  one-time migration endpoint (`/api/backfill-index`, also in the admin UI)
  populates both indexes for records that existed before the index did.
- **UI polish pass** across the admin, watch, and bundle pages — hover/focus
  states, a real overlay modal, status pills, striped/scrollable tables.
  Cosmetic only; no fetch calls, payloads, or auth logic touched.

### Fixed
- **Stale bundles.** Cleanup now also retires a bundle the moment none of
  its listed members are still live (revoked, expired, or deleted),
  regardless of the bundle's own (only-ever-growing) expiry.
- **Host header poisoning in email links (CodeQL critical).** `SITE_URL` is
  now required for building outbound email links; the previous fallback to
  the request's spoofable `Host` header is gone. Also hardened both public
  gate endpoints so a missing `SITE_URL`/`GATE_SECRET` can no longer act as
  an oracle distinguishing a matched email from an unmatched one.
- **Three dependency CVEs patched:** `next` 16.2.10 → 16.2.11 (a
  middleware/proxy-bypass advisory and a Server Actions DoS advisory), and
  `sharp` pinned to `^0.35.3` (four libvips CVEs, on an unreachable code
  path). `npm audit` now reports zero vulnerabilities.

**Full Changelog**: https://github.com/MarineTeam/MarineTeamVideos/compare/v1.4.0...v1.5.0
