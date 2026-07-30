import { baseUrl, parseEmails } from "../../lib/shares";
import { addInvitees, getInviteWithStatus } from "../../lib/invites";
import { resolveGroupEmails } from "../../lib/groups";
import { withApiMonitor } from "../../lib/withMonitor";

// Admin-only (covered by the default middleware matcher, same as /api/share).
// GET  ?videoId=<id>   -> current invite list for one video, with live status.
// POST {videoId, videoTitle, emails, groupIds, hours, watermark, notify} ->
//      adds any emails (plus each named viewer group's members, see
//      lib/groups.js) not already on the list (each becomes a normal share
//      record);
//      unless notify is explicitly false, each new addition also gets the
//      usual notification email. Emails already on the list are untouched.
async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const { videoId } = req.query;
      if (!videoId) return res.status(400).json({ error: "videoId is required" });
      const invite = await getInviteWithStatus(videoId);
      return res.status(200).json({ invite });
    }

    if (req.method === "POST") {
      const { videoId, videoTitle, emails, groupIds, hours, watermark, notify } = req.body || {};
      const groupEmails = await resolveGroupEmails(groupIds);
      const recipients = parseEmails([...(Array.isArray(emails) ? emails : [emails]), ...groupEmails]);
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
        notify: notify !== false,
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

export default withApiMonitor(handler);
