import { kvGet, kvSet } from "../../../lib/kv";
import { withApiMonitor } from "../../../lib/withMonitor";

// Admin-only (covered by the default middleware matcher). Raises a share's
// view cap so a "Used up" link works again — the view-cap equivalent of
// /api/share/extend, and deliberately shaped the same way.
//
// RAISES THE CAP; NEVER RESETS THE COUNT. That was the open design question
// in roadmap item (p) and it resolves the same way everything else in this
// repo does: never destroy evidence. `viewCount` is the audit trail of how
// often a recipient actually opened the link, and it feeds the per-video
// analytics rollup — zeroing it would quietly corrupt both. Raising the cap
// leaves the history intact and readable as what it is: "they watched 3
// times, I granted 2 more."
//
// Like extendOne, this refuses a REVOKED share: revocation is a deliberate
// access denial and must not be undoable as a side effect of a quota
// change. Restore is its own explicit action.
//
// It also refuses a share with NO cap. There is nothing to raise on an
// unlimited share, and IMPOSING a cap is a tightening of access, which in
// this codebase is always a separate, visible action (see Revoke) rather
// than something an endpoint named "allow more" does by surprise.
//
// Exported so allow-views-bulk.js reuses the exact same per-token logic.
export async function allowMoreViews({ token, views }) {
  const record = await kvGet(`bunnyshare:${token}`);
  if (!record) return { token, ok: false, error: "Share not found" };
  if (record.revoked) return { token, ok: false, error: "Cannot raise the view limit on a revoked share" };
  if (!record.maxViews) return { token, ok: false, error: "This share has no view limit" };

  const add = Number(views);
  if (!Number.isInteger(add) || add <= 0) {
    return { token, ok: false, error: "views must be a positive whole number" };
  }

  // Mirrors extendOne's `Math.max(Date.now(), expiresAt) + addMs`: measure
  // the grant from wherever the share actually stands now, so a share that
  // somehow ran past its cap still gets exactly `views` more openings
  // rather than fewer.
  const maxViews = Math.max(record.maxViews, record.viewCount || 0) + add;
  await kvSet(`bunnyshare:${token}`, { ...record, maxViews });

  return { token, ok: true, maxViews, viewCount: record.viewCount || 0 };
}

function statusCodeFor(error) {
  if (error === "Share not found") return 404;
  return 400;
}

async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const { token, views } = req.body || {};
    if (!token || !views) {
      return res.status(400).json({ error: "token and views are required" });
    }

    const result = await allowMoreViews({ token, views });
    if (!result.ok) {
      return res.status(statusCodeFor(result.error)).json({ error: result.error });
    }
    res.status(200).json({ ok: true, maxViews: result.maxViews, viewCount: result.viewCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
