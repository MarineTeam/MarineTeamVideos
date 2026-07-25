import { kvGet, kvSet } from "../../../lib/kv";
import { normalizeEmail } from "../../../lib/gate";
import { inviteKey } from "../../../lib/invites";
import { revokeOne } from "../revoke";

// Admin-only (covered by the default middleware matcher). Removes one email
// from a video's invite list AND revokes their underlying share (same
// revoke-is-a-flag semantics as /api/revoke — the bunnyshare: record is
// never deleted, only flagged). Re-adding the same email later via
// /api/video-invite is treated as a brand new invite: a fresh token and a
// fresh email, since they no longer appear in the list's membership.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const { videoId, email } = req.body || {};
    if (!videoId || !email) {
      return res.status(400).json({ error: "videoId and email are required" });
    }

    const record = await kvGet(inviteKey(videoId));
    const norm = normalizeEmail(email);
    const member = record && record.members.find((m) => normalizeEmail(m.email) === norm);
    if (!member) return res.status(404).json({ error: "That email is not on the invite list" });

    await revokeOne(member.token);
    record.members = record.members.filter((m) => normalizeEmail(m.email) !== norm);
    await kvSet(inviteKey(videoId), record);

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
