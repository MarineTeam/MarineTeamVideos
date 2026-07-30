// Request-scoped query/performance monitor. Off by default; toggled purely by
// the QUERY_MONITOR env var (mirrors the "DEBUG=1" convention), never a
// KV-backed admin setting, so it can never be flipped for other admins by a
// stray click and always reflects what's actually deployed.
//
// Uses AsyncLocalStorage so each request gets its own fresh store — nothing
// is kept in a module-level variable, which is what caused the previous
// implementation to freeze on the first page load's numbers forever.
import { AsyncLocalStorage } from "async_hooks";

const als = new AsyncLocalStorage();

export function isMonitorEnabled() {
  const v = (process.env.QUERY_MONITOR || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

// Runs fn inside a fresh per-request store. When disabled, this is a plain
// passthrough with no AsyncLocalStorage overhead at all.
//
// Uses Date.now() rather than process.hrtime — this module is transitively
// imported by middleware.js (via lib/kv.js), which runs in the Edge Runtime,
// where hrtime/memoryUsage don't exist. Date.now() works in both runtimes;
// millisecond resolution is plenty for this purpose.
export function runWithMonitor(fn) {
  if (!isMonitorEnabled()) return fn();
  return als.run({ start: Date.now(), queries: [] }, fn);
}

export function recordQuery(op, key, ms) {
  const store = als.getStore();
  if (!store) return;
  store.queries.push({ op, key, ms: Math.round(ms * 100) / 100 });
}

// Returns null when the monitor is off or called outside a monitored request.
export function getMonitorSnapshot() {
  const store = als.getStore();
  if (!store) return null;
  const totalMs = Date.now() - store.start;
  // process.memoryUsage doesn't exist in the Edge Runtime; feature-detect.
  const memoryMB =
    typeof process.memoryUsage === "function"
      ? Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10
      : null;
  return {
    totalMs,
    queryCount: store.queries.length,
    queries: store.queries,
    memoryMB,
  };
}
