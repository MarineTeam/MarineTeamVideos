import { useState } from "react";

// Renders only when the server actually attached monitor data to this
// request's props (i.e. QUERY_MONITOR is on) — freshly computed by
// getServerSideProps on every render, so it can never show stale numbers
// from an earlier page load.
export default function QueryMonitorBar({ data }) {
  const [open, setOpen] = useState(false);
  if (!data) return null;

  return (
    <div style={styles.wrap}>
      <button style={styles.toggle} onClick={() => setOpen((o) => !o)}>
        ⏱ {data.totalMs}ms · {data.queryCount} {data.queryCount === 1 ? "query" : "queries"} ·{" "}
        {data.memoryMB != null ? `${data.memoryMB}MB` : "n/a"}
      </button>
      {open && (
        <div style={styles.panel}>
          {data.queries.length === 0 ? (
            <div style={styles.muted}>No KV queries this request.</div>
          ) : (
            <table style={styles.table}>
              <tbody>
                {data.queries.map((q, i) => (
                  <tr key={i}>
                    <td style={styles.opCell}>{q.op}</td>
                    <td style={styles.keyCell}>{q.key}</td>
                    <td style={styles.msCell}>{q.ms}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

const styles = {
  wrap: { position: "fixed", left: 0, bottom: 0, zIndex: 9999, fontFamily: "monospace" },
  toggle: {
    background: "#1f2328",
    color: "#7ee787",
    border: "none",
    borderTopRightRadius: 6,
    padding: "6px 10px",
    fontSize: 12,
    cursor: "pointer",
  },
  panel: {
    background: "#1f2328",
    color: "#c9d1d9",
    padding: 10,
    maxWidth: 480,
    maxHeight: 300,
    overflow: "auto",
    fontSize: 12,
  },
  muted: { color: "#8b949e" },
  table: { borderCollapse: "collapse", width: "100%" },
  opCell: { padding: "2px 8px 2px 0", color: "#79c0ff", whiteSpace: "nowrap" },
  keyCell: { padding: "2px 8px", wordBreak: "break-all" },
  msCell: { padding: "2px 0", color: "#7ee787", textAlign: "right", whiteSpace: "nowrap" },
};
