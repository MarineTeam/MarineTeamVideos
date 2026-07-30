import { extendOne } from "./extend";
import { withApiMonitor } from "../../../lib/withMonitor";

// Admin-only (covered by the default middleware matcher). Extends multiple
// existing shares by the same number of hours in one call — never fails the
// whole batch; each token's outcome is reported independently, same pattern
// as /api/share/resend-bulk.
async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const { tokens, hours } = req.body || {};
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return res.status(400).json({ error: "tokens (non-empty array) is required" });
    }
    if (!hours) {
      return res.status(400).json({ error: "hours is required" });
    }

    const results = await Promise.all(tokens.map((token) => extendOne({ token, hours })));

    res.status(200).json({
      ok: true,
      succeeded: results.filter((r) => r.ok).map((r) => ({ token: r.token, expiresAt: r.expiresAt })),
      failures: results.filter((r) => !r.ok),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
