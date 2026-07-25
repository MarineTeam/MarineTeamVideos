import { baseUrl, parseEmails } from "../../lib/shares";
import { addInvitees, getInviteWithStatus } from "../../lib/invites";

// Admin-only (covered by the default middleware matcher, same as /api/share).
// GET  ?videoId=<id>   -> current invite list for one video, with live status.
// POST {videoId, videoTitle, emails, hours, watermark} -> adds any emails not
//      already on the list (each becomes a normal share record + the usual
//      notification email); emails already on the list are untouched.
export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const { videoId } = req.query;
      if (!videoId) return res.status(400).json({ error: "videoId is required" });
      const invite = await getInviteWithStatus(videoId);
      return res.status(200).json({ invite });
    }

    if (req.method === "POST") {
      const { videoId, videoTitle, emails, hours, watermark } = req.body || {};
      const recipients = parseEmails(emails);
      if (!videoId || recipients.length === 0) {
        return res.status(400).json({ error: "videoId and at least one email are required" });
      }

      const { added, alreadyInvited, failures } = await addInvitees({
        videoId,
        videoTitle,
        emails: recipients,
        hours,
        watermark: typeof watermark === "boolean" ? watermark : undefined,
        siteUrl: baseUrl(req),
      });

      const invite = await getInviteWithStatus(videoId);
      return res.status(200).json({
        ok: true,
        invite,
        added,
        alreadyInvited,
        ...(failures.length > 0 && { failures }),
      });
    }

    res.status(405).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
