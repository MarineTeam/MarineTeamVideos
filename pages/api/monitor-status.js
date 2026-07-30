import { isMonitorEnabled } from "../../lib/monitor";

// Admin-only (default middleware matcher). Lets the admin page show a live
// ON/OFF badge for the query monitor — reads the env var fresh on every
// call, so it always reflects what's actually deployed, never a cached value.
async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();
  res.status(200).json({ enabled: isMonitorEnabled() });
}

export default handler;
