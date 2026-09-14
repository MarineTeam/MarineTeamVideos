import { loadAllShares, computeAnalytics } from "../../lib/shareQuery";
import { withApiMonitor } from "../../lib/withMonitor";

// Admin-only per-video analytics rollup.
//
// This exists as its own route because the shares table became server-side
// paged: the admin page no longer holds every share, so a rollup computed in
// the browser would quietly report "analytics for the current page" while
// looking exactly like analytics for everything. Computing it here keeps it
// honest and keeps thousands of rows out of the browser, which was the point
// of paging in the first place.
//
// Covered by the existing middleware matcher like every other non-watch,
// non-bundle API route — no matcher change needed.
async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();
  try {
    const analytics = computeAnalytics(await loadAllShares());
    res.status(200).json({ analytics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
