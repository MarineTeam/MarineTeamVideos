import { kvGet, kvSet } from "../../../lib/kv";
import { verifyGrant } from "../../../lib/gate";
import { withApiMonitor } from "../../../lib/withMonitor";
import { getSettings } from "../../../lib/settings";
import { sendFirstPlayNotificationEmail, adminNotifyAddress } from "../../../lib/mailer";

// PUBLIC (under /api/watch/*, excluded from admin Basic Auth). Records real
// playback events reported by the Bunny embed player on the /watch page.
// Requires a valid token-bound grant (the short-lived tracking grant the
// authorized page render passes to the client), so counters can't be
// inflated by anyone who merely knows a token. All written fields are
// additive to the share record.
async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { token, auth, event, progressPct, positionSec, durationSec } = req.body || {};
    if (!token || !auth || !event) {
      return res.status(400).json({ error: "token, auth and event are required" });
    }
    if (!verifyGrant(auth, { token })) {
      return res.status(403).json({ error: "invalid or expired auth" });
    }

    const record = await kvGet(`bunnyshare:${token}`);
    if (!record || record.revoked || Date.now() > record.expiresAt) {
      return res.status(403).json({ error: "share not active" });
    }

    const now = Date.now();
    const updated = { ...record };

    // True the FIRST time this share is ever played, and only then. Used
    // below to fire the admin notification exactly once per share.
    const isFirstPlay = event === "play" && !record.firstPlayedAt;

    if (event === "play") {
      updated.playCount = (record.playCount || 0) + 1;
      updated.firstPlayedAt = record.firstPlayedAt || now;
      updated.lastPlayedAt = now;
    } else if (event === "progress" || event === "ended") {
      const pct = Math.max(0, Math.min(100, Math.round(Number(progressPct) || 0)));
      updated.maxProgressPct = Math.max(record.maxProgressPct || 0, event === "ended" ? 100 : pct);
      updated.lastPlayedAt = now;
      if (event === "ended") {
        updated.completedAt = record.completedAt || now;
      }
    } else if (event === "position") {
      // Resume support: remember where this viewer left off, so a return
      // visit can offer to pick up where they stopped. Additive fields;
      // last-writer-wins is fine (the newest reported position is the one we
      // want). Duration lets the watch page decide whether a resume offer
      // makes sense (skip it when they're basically at the end).
      const pos = Number(positionSec);
      if (Number.isFinite(pos) && pos >= 0) updated.lastPositionSec = pos;
      const dur = Number(durationSec);
      if (Number.isFinite(dur) && dur > 0) updated.durationSec = dur;
      updated.lastPlayedAt = now;
    } else {
      return res.status(400).json({ error: "unknown event" });
    }

    await kvSet(`bunnyshare:${token}`, updated);

    // Opt-in admin notification on first play. Deliberately AFTER the record
    // write and fully swallowed on failure: tracking is fire-and-forget from
    // the player's point of view, and a mailer outage must never turn into a
    // failed track call or a changed response. This route is public, so the
    // send is bounded three ways — it needs a valid tracking grant, an
    // active share, and a record that has never been played before, which
    // means at most ONE email per share for the life of that share.
    if (isFirstPlay) {
      try {
        const settings = await getSettings();
        const notifyTo = adminNotifyAddress();
        if (settings.notifyOnFirstPlay && notifyTo) {
          await sendFirstPlayNotificationEmail({
            to: notifyTo,
            videoTitle: record.videoTitle,
            recipientEmail: record.email,
            viewedAt: now,
          });
        }
      } catch (err) {
        console.error("first-play notification failed (non-fatal):", err);
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
