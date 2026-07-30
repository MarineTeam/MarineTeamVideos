import { createShareRecord, setEmailFailed, baseUrl, parseEmails } from "../../lib/shares";
import { findOrExtendBundle, getBundleItems } from "../../lib/bundles";
import { sendBulkShareEmail } from "../../lib/mailer";
import { resolveGroupEmails } from "../../lib/groups";
import { withApiMonitor } from "../../lib/withMonitor";

// Creates a separate share (distinct token + link) for every recipient x video
// pair and emails each recipient one message listing only THEIR links. Every
// pair gets its own record on purpose: access is revocable per person per
// video, and views are tracked per person (see /watch/[token]).
async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { videos, emails, email, groupIds, hours, watermark } = req.body;
    // parseEmails splits comma/semicolon/whitespace-joined strings in BOTH
    // shapes — a legacy client sending email:"a@b.c, d@e.f" must fan out to
    // two recipients, never become one record with a combined email string.
    // groupIds (optional) resolves each named viewer group (lib/groups.js)
    // to its member emails and folds them into the same recipient list, so
    // "share with Team A" needs no more than typing their emails would.
    const groupEmails = await resolveGroupEmails(groupIds);
    const typed = Array.isArray(emails ?? email) ? emails ?? email : [emails ?? email];
    const recipients = parseEmails([...typed, ...groupEmails]);

    if (!Array.isArray(videos) || videos.length === 0 || recipients.length === 0) {
      return res
        .status(400)
        .json({ error: "videos (non-empty array) and emails (at least one) are required" });
    }

    const siteUrl = baseUrl(req);
    const results = [];
    const failures = [];

    for (const to of recipients) {
      const created = [];
      for (const v of videos) {
        const videoId = v && v.id;
        if (!videoId) continue;
        const { record, link } = await createShareRecord({
          videoId,
          videoTitle: v.title,
          email: to,
          hours,
          siteUrl,
          watermark: typeof watermark === "boolean" ? watermark : undefined,
        });
        created.push({ token: record.token, videoId, videoTitle: record.videoTitle, link, expiresAt: record.expiresAt });
      }
      if (created.length === 0) {
        return res.status(400).json({ error: "No valid videos to share" });
      }

      // Group this recipient's tokens under one gated listing page — reusing
      // their existing bundle if they already have one (so a recipient
      // shared with across several separate calls keeps ONE page/link, and
      // this call's notification folds into it instead of standing alone).
      // The bundle record exists independent of the notification email
      // below — it's just as valid to hand out even if the email send fails.
      const { record: bundle, link: bundleLink } = await findOrExtendBundle({ email: to, members: created, siteUrl });

      try {
        // Built from the bundle's full current membership, not just this
        // call's `created` — a recipient with prior active shares gets ONE
        // email listing everything currently active, not a new standalone
        // notification for just what's new.
        const items = await getBundleItems(bundle.tokens, siteUrl);
        await sendBulkShareEmail({
          to,
          items,
          expiresAt: bundle.expiresAt,
          bundleLink,
        });
        results.push({ email: to, links: created.map((c) => ({ videoId: c.videoId, link: c.link })), bundleLink });
      } catch (err) {
        // Records exist but this recipient's email failed — flag each one so
        // they aren't silent ghosts in the admin table (persists past reload,
        // unlike the one-time failures array below), and report it rather
        // than failing the whole batch (other recipients may have succeeded).
        await Promise.all(created.map((c) => setEmailFailed(c.token, true, err.message)));
        failures.push({ email: to, error: err.message, bundleLink });
      }
    }

    if (results.length === 0) {
      return res.status(500).json({ error: `All emails failed: ${failures.map((f) => f.error).join("; ")}` });
    }

    res.status(200).json({
      ok: true,
      count: results.reduce((n, r) => n + r.links.length, 0),
      recipients: results,
      ...(failures.length > 0 && { failures }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
