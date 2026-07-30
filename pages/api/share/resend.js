import { kvGet } from "../../../lib/kv";
import { setEmailFailed, baseUrl } from "../../../lib/shares";
import { sendShareEmail } from "../../../lib/mailer";
import { withApiMonitor } from "../../../lib/withMonitor";

// Admin-only (covered by the default middleware matcher, unlike /api/watch/*).
// Re-sends the notification for one existing share record — usable any time,
// not only after a send failure (an admin may want to nudge a recipient who
// says they never got it). Resends as a plain single-link email regardless
// of whether the record was created via bulk share. Exported so
// resend-bulk.js can reuse the exact same per-token logic.
export async function resendOne({ token, siteUrl }) {
  const record = await kvGet(`bunnyshare:${token}`);
  if (!record) return { token, ok: false, error: "Share not found" };
  if (record.revoked || Date.now() > record.expiresAt) {
    return { token, ok: false, error: "Share is revoked or expired" };
  }

  const link = `${siteUrl}/watch/${token}`;
  try {
    await sendShareEmail({
      to: record.email,
      videoTitle: record.videoTitle,
      link,
      expiresAt: record.expiresAt,
    });
    await setEmailFailed(token, false);
    return { token, ok: true };
  } catch (err) {
    await setEmailFailed(token, true, err.message);
    return { token, ok: false, error: err.message };
  }
}

function statusCodeFor(error) {
  if (error === "Share not found") return 404;
  if (error === "Share is revoked or expired") return 400;
  return 502;
}

async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "token is required" });

    const result = await resendOne({ token, siteUrl: baseUrl(req) });
    if (!result.ok) {
      return res.status(statusCodeFor(result.error)).json({ error: result.error });
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
