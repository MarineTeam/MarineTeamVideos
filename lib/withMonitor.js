// Wraps an API route handler so that, when QUERY_MONITOR is on, the response
// carries an X-Query-Monitor header with this request's KV query count,
// per-query timings, total handler time, and process memory. Computed fresh
// per request (see lib/monitor.js) so it can never go stale across page loads.
//
// When the monitor is off, withApiMonitor returns the handler untouched —
// zero added overhead in the common case.
import { runWithMonitor, getMonitorSnapshot, isMonitorEnabled } from "./monitor";

export function withApiMonitor(handler) {
  if (!isMonitorEnabled()) return handler;

  return function monitoredHandler(req, res) {
    return runWithMonitor(async () => {
      const originalJson = res.json.bind(res);
      let attached = false;
      res.json = (body) => {
        if (!attached && !res.headersSent) {
          attached = true;
          const snapshot = getMonitorSnapshot();
          if (snapshot) res.setHeader("X-Query-Monitor", JSON.stringify(snapshot));
        }
        return originalJson(body);
      };
      await handler(req, res);
    });
  };
}
