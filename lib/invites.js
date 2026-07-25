import { kvGet, kvSet } from "./kv";
import { normalizeEmail } from "./gate";
import { createShareRecord, setEmailFailed } from "./shares";
import { findOrExtendBundle, getBundleItems } from "./bundles";
import { sendShareEmail, sendBulkShareEmail } from "./mailer";

// A per-video, persistently-editable invite list — "private video" sharing
// in the YouTube sense: an admin maintains a standing list of who currently
// has access to one video, adding and removing people over time. This is a
// thin layer ON TOP of the existing per-recipient bunnyshare: records (see
// lib/shares.js) — it never replaces them. Each invitee is backed by the
// exact same share record/token/email-gate/bundle machinery that Share and
// Bulk Share already use; this file only tracks CURRENT LIST MEMBERSHIP so
// the admin can see and edit it, and so re-adding someone already on the
// list doesn't re-create a record or re-send an email.
export function inviteKey(videoId) {
  return `bunnyinvite:${videoId}`;
}

export async function getInviteRecord(videoId) {
  const record = await kvGet(inviteKey(videoId));
  return record || { videoId, videoTitle: null, members: [] };
}

// Adds any of `emails` not already on the list: creates a normal share
// record (same createShareRecord/findOrExtendBundle path as /api/share) and,
// unless `notify` is false, sends the usual notification email — then
// appends {email, token} to the list. Emails already on the list are left
// completely alone — no new record, no email — so editing the list only
// ever notifies people who are new. `notify: false` (a YouTube/Drive-style
// "don't send an email" option) still creates a fully live, working link —
// it only skips the send, e.g. for an admin who'll hand the link out some
// other way.
export async function addInvitees({ videoId, videoTitle, emails, hours, watermark, siteUrl, notify = true }) {
  const record = await getInviteRecord(videoId);
  record.videoId = videoId;
  record.videoTitle = videoTitle || record.videoTitle || videoId;

  const existing = new Set(record.members.map((m) => normalizeEmail(m.email)));
  const added = [];
  const alreadyInvited = [];
  const failures = [];

  for (const rawEmail of emails) {
    const norm = normalizeEmail(rawEmail);
    if (existing.has(norm)) {
      alreadyInvited.push(rawEmail);
      continue;
    }
    existing.add(norm);

    const { record: shareRecord, link } = await createShareRecord({
      videoId,
      videoTitle: record.videoTitle,
      email: rawEmail,
      hours,
      siteUrl,
      watermark,
    });

    const { record: bundle, link: bundleLink } = await findOrExtendBundle({
      email: rawEmail,
      members: [{ token: shareRecord.token, expiresAt: shareRecord.expiresAt }],
      siteUrl,
    });

    if (notify) {
      try {
        if (bundle.tokens.length > 1) {
          const items = await getBundleItems(bundle.tokens, siteUrl);
          await sendBulkShareEmail({ to: rawEmail, items, expiresAt: bundle.expiresAt, bundleLink });
        } else {
          await sendShareEmail({
            to: rawEmail,
            videoTitle: record.videoTitle,
            link,
            expiresAt: shareRecord.expiresAt,
          });
        }
        added.push({ email: rawEmail, token: shareRecord.token, link, bundleLink });
      } catch (err) {
        // Same pattern as /api/share: the record (and access) is live either
        // way — flag the failed send instead of losing the invite entirely.
        await setEmailFailed(shareRecord.token, true, err.message);
        failures.push({ email: rawEmail, token: shareRecord.token, link, bundleLink, error: err.message });
        added.push({ email: rawEmail, token: shareRecord.token, link, bundleLink });
      }
    } else {
      added.push({ email: rawEmail, token: shareRecord.token, link, bundleLink, notified: false });
    }

    record.members.push({ email: rawEmail, token: shareRecord.token, addedAt: Date.now() });
  }

  await kvSet(inviteKey(videoId), record);
  return { record, added, alreadyInvited, failures };
}

// Merges each member's LIVE status from its own bunnyshare:<token> record —
// the invite record only ever stores {email, token, addedAt}; status is
// never duplicated into it, same "never a second source of truth" principle
// lib/bundles.js applies to bundle membership.
export async function getInviteWithStatus(videoId) {
  const record = await getInviteRecord(videoId);
  const members = await Promise.all(
    record.members.map(async (m) => {
      const share = await kvGet(`bunnyshare:${m.token}`);
      return {
        email: m.email,
        token: m.token,
        addedAt: m.addedAt,
        revoked: share ? share.revoked : true,
        expiresAt: share ? share.expiresAt : null,
        emailFailed: share ? !!share.emailFailed : false,
      };
    })
  );
  return { videoId: record.videoId, videoTitle: record.videoTitle, members };
}
