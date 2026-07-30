import { kvGet, kvSet } from "../../../lib/kv";
import { extendBundleForToken } from "../../../lib/bundles";
import { withApiMonitor } from "../../../lib/withMonitor";

// Admin-only (covered by the default middleware matcher). Extends a share's
// expiresAt instead of the only prior option — revoke + re-share, which
// breaks the existing link. Works on an already-expired-but-not-revoked
// share too (extends from now, not from the stale past expiry), since
// "give them a few more days" after a link lapsed is the common case.
// Revoked shares can't be extended — that's a deliberate access denial, not
// something this endpoint should quietly undo. Exported so extend-bulk.js
// can reuse the exact same per-token logic.
export async function extendOne({ token, hours }) {
  const record = await kvGet(`bunnyshare:${token}`);
  if (!record) return { token, ok: false, error: "Share not found" };
  if (record.revoked) return { token, ok: false, error: "Cannot extend a revoked share" };

  const addMs = Number(hours) * 3600 * 1000;
  if (!Number.isFinite(addMs) || addMs <= 0) {
    return { token, ok: false, error: "hours must be a positive number" };
  }

  const expiresAt = Math.max(Date.now(), record.expiresAt) + addMs;
  await kvSet(`bunnyshare:${token}`, { ...record, expiresAt });
  await extendBundleForToken(token, expiresAt);

  return { token, ok: true, expiresAt };
}

function statusCodeFor(error) {
  if (error === "Share not found") return 404;
  return 400;
}

async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const { token, hours } = req.body || {};
    if (!token || !hours) {
      return res.status(400).json({ error: "token and hours are required" });
    }

    const result = await extendOne({ token, hours });
    if (!result.ok) {
      return res.status(statusCodeFor(result.error)).json({ error: result.error });
    }
    res.status(200).json({ ok: true, expiresAt: result.expiresAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
