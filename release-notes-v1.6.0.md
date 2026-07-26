## v1.6.0

Named viewer groups, per-collection sharing, and a fix for a layout bug in
the group picker. All additive — existing share tokens, `/watch` links,
gate cookies, and KV records keep working unchanged.

### Added
- **Named viewer groups.** Labelled, admin-editable lists of emails (e.g.
  "Team A") that can be inserted into Bulk Share or a video's Private list
  instead of retyping the same recipients every time. Manage them from a
  new "👥 Viewer groups" panel; `/api/share-bulk` and `/api/video-invite`
  accept an optional `groupIds` array resolved into the recipient list
  alongside typed emails. A group only supplies emails — it grants no
  access itself, so editing or deleting one never touches shares already
  created from its members.
- **Per-collection sharing.** If your Bunny Stream library organizes videos
  into collections, the admin page now shows a button per collection above
  the video grid ("📁 Team Offsite (12)"); clicking one selects every video
  in that collection, feeding straight into the existing Bulk Share flow —
  no separate sharing path, just a shortcut into the one that already
  exists.

### Fixed
- **Group-picker dropdown crushing the recipient email input.** The
  "+ Add group..." dropdown in the Bulk Share bar and Private list modal
  had no explicit width, inherited the global full-width `<select>` style,
  and squeezed the adjacent email input down to a near-invisible sliver —
  making it impossible to type emails once a group existed. Both controls
  now keep a usable width side by side.

**Full Changelog**: https://github.com/MarineTeam/MarineTeamVideos/compare/v1.5.0...v1.6.0
