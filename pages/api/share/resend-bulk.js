import { baseUrl } from "../../../lib/shares";
import { resendOne } from "./resend";
import { withApiMonitor } from "../../../lib/withMonitor";

// Admin-only (covered by the default middleware matcher). Resends
// notifications for multiple existing shares in one call — never fails the
// whole batch; each token's outcome is reported independently, same as
// /api/share-bulk's per-recipient failures array.
async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const { tokens } = req.body || {};
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return res.status(400).json({ error: "tokens (non-empty array) is required" });
    }

    const siteUrl = baseUrl(req);
    const results = await Promise.all(tokens.map((token) => resendOne({ token, siteUrl })));

    res.status(200).json({
      ok: true,
      succeeded: results.filter((r) => r.ok).map((r) => r.token),
      failures: results.filter((r) => !r.ok),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
