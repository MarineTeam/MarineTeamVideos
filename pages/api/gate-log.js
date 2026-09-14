import { readRecentExchanges } from "../../lib/gateLog";
import { withApiMonitor } from "../../lib/withMonitor";

// Admin-only (covered by the default middleware matcher, like every other
// non-watch/non-bundle API route). Returns the most recent grant exchanges,
// newest first, for incident forensics.
//
// Deliberately an endpoint with no admin-page UI. The forensics question
// ("who got in, when, from where") is rare and investigative; putting it on
// the dashboard would add clutter and a new failure surface to the busiest
// page for a view nobody needs day to day. The runbook documents the curl.
//
// Emails appear only as a fingerprint — see lib/gateLog.js for why. To turn
// one back into an identity, look up the share record for that token.
async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();
  try {
    const exchanges = await readRecentExchanges(req.query.limit);
    res.status(200).json({ exchanges, count: exchanges.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
