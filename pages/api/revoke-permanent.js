import { kvGet, kvDel, kvSrem } from "../../lib/kv";
import { SHARE_INDEX_KEY } from "../../lib/shares";
import { withApiMonitor } from "../../lib/withMonitor";

// Admin-only (covered by the default middleware matcher). Irreversibly
// deletes a share record — unlike Revoke (a reversible flag flip; see
// pages/api/revoke.js / pages/api/unrevoke.js), this actually removes the
// `bunnyshare:<token>` key. It's the exact same operation /api/cleanup.js
// already performs in bulk for every revoked-or-expired record, just
// on-demand for one token instead of waiting for the next cleanup run.
// Only allowed once a share is already revoked — deletion is a second,
// deliberate step after Revoke, never a shortcut around it (an active
// share must be revoked first; non-negotiable 9 keeps Revoke itself a
// flag flip). A bundle referencing this token isn't touched here — bundle
// records already treat a missing member's record as "skip it" (see
// getBundleMembers/getBundleItems in lib/bundles.js), same as when
// cleanup deletes a share that happened to be in a bundle.
export async function permanentlyDeleteOne(token) {
  const record = await kvGet(`bunnyshare:${token}`);
  if (!record) return { token, ok: false, error: "Share not found" };
  if (!record.revoked) {
    return { token, ok: false, error: "Only a revoked share can be permanently deleted" };
  }
  await kvDel(`bunnyshare:${token}`);
  await kvSrem(SHARE_INDEX_KEY, token);
  return { token, ok: true };
}

async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "token is required" });

    const result = await permanentlyDeleteOne(token);
    if (!result.ok) {
      const status = result.error === "Share not found" ? 404 : 400;
      return res.status(status).json({ error: result.error });
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
