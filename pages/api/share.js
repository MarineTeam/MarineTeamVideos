import { createShareRecord, setEmailFailed, baseUrl, parseEmails } from "../../lib/shares";
import { findOrExtendBundle, getBundleItems } from "../../lib/bundles";
import { sendShareEmail, sendBulkShareEmail } from "../../lib/mailer";
import { withApiMonitor } from "../../lib/withMonitor";

async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { videoId, videoTitle, email, hours, watermark } = req.body;
    const recipients = parseEmails(email);
    if (!videoId || recipients.length === 0) {
      return res.status(400).json({ error: "videoId and email are required" });
    }

    // A comma-separated email field fans out: one record + one email per
    // recipient, so each gets their own link and can pass the email gate.
    const siteUrl = baseUrl(req);
    const links = [];
    const failures = [];
    for (const to of recipients) {
      const { record, link } = await createShareRecord({
        videoId,
        videoTitle,
        email: to,
        hours,
        siteUrl,
        watermark: typeof watermark === "boolean" ? watermark : undefined,
      });

      // Every recipient gets (or extends) a bundle, so a later share to the
      // same address always has something to fold into. Only the EMAIL
      // content changes based on what's in it: a recipient with no other
      // active shares still gets the plain single-video email; one with
      // existing active shares gets ONE consolidated email listing
      // everything current — instead of yet another standalone notification.
      const { record: bundle, link: bundleLink } = await findOrExtendBundle({
        email: to,
        members: [{ token: record.token, expiresAt: record.expiresAt }],
        siteUrl,
      });

      try {
        if (bundle.tokens.length > 1) {
          const items = await getBundleItems(bundle.tokens, siteUrl);
          await sendBulkShareEmail({ to, items, expiresAt: bundle.expiresAt, bundleLink });
        } else {
          await sendShareEmail({
            to,
            videoTitle: record.videoTitle,
            link,
            expiresAt: record.expiresAt,
          });
        }
        links.push({ email: to, link, bundleLink });
      } catch (err) {
        // The record exists (link is live) even though the notification
        // failed — flag it so it isn't a silent ghost in the admin table,
        // and report the failure instead of 500ing the whole batch.
        await setEmailFailed(record.token, true, err.message);
        failures.push({ email: to, link, error: err.message, bundleLink });
      }
    }

    if (links.length === 0) {
      return res.status(500).json({ error: `All emails failed: ${failures.map((f) => f.error).join("; ")}` });
    }

    res.status(200).json({
      ok: true,
      link: links[0].link,
      links,
      ...(failures.length > 0 && { failures }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
