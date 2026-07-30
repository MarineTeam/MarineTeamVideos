import { kvGet, kvSet } from "../../../lib/kv";
import { verifyGrant } from "../../../lib/gate";
import { withApiMonitor } from "../../../lib/withMonitor";

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
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
