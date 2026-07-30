import { kvGet, kvSet } from "../../lib/kv";
import { withApiMonitor } from "../../lib/withMonitor";

// Admin-only (covered by the default middleware matcher). Idempotent:
// revoking an already-revoked share succeeds without complaint — the end
// state (revoked: true) is the same either way. Exported so revoke-bulk.js
// can reuse the exact same per-token logic.
export async function revokeOne(token) {
  const record = await kvGet(`bunnyshare:${token}`);
  if (!record) return { token, ok: false, error: "Share not found" };
  if (!record.revoked) {
    await kvSet(`bunnyshare:${token}`, { ...record, revoked: true });
  }
  return { token, ok: true };
}

async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "token is required" });

    const result = await revokeOne(token);
    if (!result.ok) return res.status(404).json({ error: result.error });

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
