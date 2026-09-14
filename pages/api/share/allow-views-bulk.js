import { allowMoreViews } from "./allow-views";
import { withApiMonitor } from "../../../lib/withMonitor";

// Admin-only (covered by the default middleware matcher). Raises the view
// cap on several shares at once — never fails the whole batch; each token's
// outcome is reported independently, the same pattern as
// /api/share/extend-bulk and /api/share/resend-bulk.
async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const { tokens, views } = req.body || {};
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return res.status(400).json({ error: "tokens (non-empty array) is required" });
    }
    if (!views) {
      return res.status(400).json({ error: "views is required" });
    }

    const results = await Promise.all(tokens.map((token) => allowMoreViews({ token, views })));

    res.status(200).json({
      ok: true,
      succeeded: results.filter((r) => r.ok).map((r) => ({ token: r.token, maxViews: r.maxViews })),
      failures: results.filter((r) => !r.ok),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
