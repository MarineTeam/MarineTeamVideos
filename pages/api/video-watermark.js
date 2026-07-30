import { setVideoWatermark } from "../../lib/settings";
import { withApiMonitor } from "../../lib/withMonitor";

// Admin-only (not under /api/watch/ or /api/bundle/, so the middleware matcher
// puts it behind Basic Auth). Sets or clears one video's watermark override
// from the Videos grid. Body: { videoId, choice } where choice is
// "on" | "off" | "default" (default clears the override -> inherit global).
async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const { videoId, choice } = req.body || {};
    if (!videoId) return res.status(400).json({ error: "videoId is required" });
    const value = choice === "on" ? true : choice === "off" ? false : null;
    const settings = await setVideoWatermark(videoId, value);
    res.status(200).json({ ok: true, settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
