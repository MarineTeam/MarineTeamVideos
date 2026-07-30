import { useEffect, useState } from "react";
import { getClientMonitorEntries, subscribeClientMonitor } from "../lib/clientMonitorStore";

// Admin-page badge + panel. Shows whether QUERY_MONITOR is on (from
// /api/monitor-status, re-fetched on every mount — i.e. every page load) and,
// when on, a running list of this page session's own API calls collected via
// the X-Query-Monitor response header. The entry list is component state
// seeded fresh on mount, so a reload always starts at zero — it can never
// carry over stale numbers from an earlier load.
export default function QueryMonitorPanel() {
  const [enabled, setEnabled] = useState(null); // null = loading
  const [entries, setEntries] = useState(() => getClientMonitorEntries());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/monitor-status")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setEnabled(!!data.enabled);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => subscribeClientMonitor(setEntries), []);

  const totalQueries = entries.reduce((sum, e) => sum + (e.queryCount || 0), 0);
  const totalMs = entries.reduce((sum, e) => sum + (e.totalMs || 0), 0);

  return (
    <div style={styles.wrap}>
      <button style={styles.badge(enabled)} onClick={() => setOpen((o) => !o)}>
        Query Monitor:{" "}
        {enabled === null ? "…" : enabled ? "ON" : "OFF"}
        {enabled ? ` · ${entries.length} calls · ${totalQueries} queries · ${Math.round(totalMs)}ms` : ""}
      </button>
      {open && enabled && (
        <div style={styles.panel}>
          {entries.length === 0 ? (
            <div style={styles.muted}>No API calls tracked yet this page load.</div>
          ) : (
            <table style={styles.table}>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={i}>
                    <td style={styles.urlCell}>{e.url}</td>
                    <td style={styles.numCell}>{e.queryCount}q</td>
                    <td style={styles.numCell}>{e.totalMs}ms</td>
                    <td style={styles.numCell}>{e.memoryMB != null ? `${e.memoryMB}MB` : "n/a"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {open && enabled === false && (
        <div style={styles.panel}>
          <div style={styles.muted}>
            Set the <code>QUERY_MONITOR</code> env var to <code>1</code> and redeploy to enable.
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  wrap: { position: "fixed", right: 12, bottom: 12, zIndex: 9999, fontFamily: "monospace" },
  badge: (enabled) => ({
    background: enabled ? "#1a7f37" : "#57606a",
    color: "white",
    border: "none",
    borderRadius: 6,
    padding: "6px 10px",
    fontSize: 12,
    cursor: "pointer",
  }),
  panel: {
    marginTop: 6,
    background: "#1f2328",
    color: "#c9d1d9",
    padding: 10,
    maxWidth: 480,
    maxHeight: 300,
    overflow: "auto",
    fontSize: 12,
    borderRadius: 6,
  },
  muted: { color: "#8b949e" },
  table: { borderCollapse: "collapse", width: "100%" },
  urlCell: { padding: "2px 8px 2px 0", wordBreak: "break-all" },
  numCell: { padding: "2px 6px", color: "#7ee787", whiteSpace: "nowrap", textAlign: "right" },
};
