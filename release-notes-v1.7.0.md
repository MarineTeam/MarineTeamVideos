## v1.7.0

The viewer group picker from Bulk Share and the Private list is now also
available in the single-video Share modal. Additive UI-only change —
existing share tokens, `/watch` links, gate cookies, and KV records keep
working unchanged.

### Added
- **Viewer group picker in the single-video Share modal.** The
  "+ Add group..." dropdown already existed in Bulk Share and the Private
  list; the regular per-video Share button lacked it, forcing recipients
  in a named group to be retyped one at a time. Picking a group now merges
  its emails into the same recipient input, using the existing
  `mergeGroupIntoEmails` helper — no API or data-model changes.

**Full Changelog**: https://github.com/MarineTeam/MarineTeamVideos/compare/v1.6.0...v1.7.0
