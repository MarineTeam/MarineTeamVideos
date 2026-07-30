import { kvGet, kvSet } from "../../lib/kv";
import { withApiMonitor } from "../../lib/withMonitor";

// Admin-only (covered by the default middleware matcher). Reverses a Revoke
// by flipping the flag back — same flag-flip-never-delete model as Revoke
// itself (pages/api/revoke.js), kept as its own explicit, separate action
// rather than folded into Extend (which deliberately refuses revoked shares
// rather than doubling as an undo — see roadmap item i). Idempotent:
// un-revoking a share that isn't revoked succeeds without complaint, same
// as revokeOne's idempotency in the other direction.
export async function unrevokeOne(token) {
  const record = await kvGet(`bunnyshare:${token}`);
  if (!record) return { token, ok: false, error: "Share not found" };
  if (record.revoked) {
    await kvSet(`bunnyshare:${token}`, { ...record, revoked: false });
  }
  return { token, ok: true };
}

async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "token is required" });

    const result = await unrevokeOne(token);
    if (!result.ok) return res.status(404).json({ error: result.error });

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
