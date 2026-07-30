// Client-side collector for the X-Query-Monitor header that withApiMonitor
// attaches to API responses when QUERY_MONITOR is on. Lives entirely in
// memory (module-level array), so a full page reload always starts empty —
// there is no way for it to show numbers from a previous page load.
const listeners = new Set();
let entries = [];

export function recordClientMonitor(entry) {
  entries = [...entries, entry];
  listeners.forEach((fn) => fn(entries));
}

export function subscribeClientMonitor(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getClientMonitorEntries() {
  return entries;
}

let patched = false;
export function installFetchMonitor() {
  if (patched || typeof window === "undefined") return;
  patched = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await originalFetch(...args);
    const header = res.headers.get("x-query-monitor");
    if (header) {
      try {
        const data = JSON.parse(header);
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
        recordClientMonitor({ url, ...data, at: Date.now() });
      } catch {
        // malformed header — ignore, never let monitoring break the app
      }
    }
    return res;
  };
}

// Installed synchronously at module load (not from a useEffect) so it's in
// place before ANY component's mount effect fires its first fetch. React
// runs effects bottom-up (children before parents), so a patch installed
// from _app.js's own useEffect would always lose the race against the admin
// page's own useEffect — which is why calls never counted above 0 before.
installFetchMonitor();
