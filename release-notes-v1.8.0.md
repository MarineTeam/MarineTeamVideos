## v1.8.0

An opt-in query monitor / performance overlay, toggled purely by the
`QUERY_MONITOR` env var. Diagnostic-only change — no effect when the flag
is off, and no changes to existing share tokens, `/watch` links, gate
cookies, or KV records.

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

**Full Changelog**: https://github.com/MarineTeam/MarineTeamVideos/compare/v1.7.0...v1.8.0
