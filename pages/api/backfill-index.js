import { kvKeys, kvSadd } from "../../lib/kv";
import { SHARE_INDEX_KEY } from "../../lib/shares";
import { BUNDLE_INDEX_KEY } from "../../lib/bundles";
import { withApiMonitor } from "../../lib/withMonitor";

// Admin-only, one-time migration (idempotent — SADD naturally dedupes, so
// it's safe to re-run). Populates the bunnyshare-index / bunnybundle-index
// SETs (lib/shares.js, lib/bundles.js) from whatever bunnyshare:*/
// bunnybundle:* records already exist, using the one full-keyspace KEYS
// scan this whole change was meant to eliminate from the hot paths (admin
// listing, cleanup, every share/bundle lookup) — every other route now
// reads the index instead; this is the one place that still does a real
// scan, on purpose, to seed it.
//
// MUST be run once after deploying this change if the store has ANY
// pre-existing bunnyshare:*/bunnybundle:* records — otherwise those
// records keep working fine (their /watch/<token> and /bundle/<id> links
// never depended on the index, only the admin listing and cleanup do) but
// silently stop appearing in the admin shares table and cleanup sweeps,
// since both now only look at the index rather than scanning everything.
async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const shareKeys = await kvKeys("bunnyshare:*");
    const shareTokens = shareKeys.map((k) => k.slice("bunnyshare:".length));
    await Promise.all(shareTokens.map((t) => kvSadd(SHARE_INDEX_KEY, t)));

    const bundleKeys = await kvKeys("bunnybundle:*");
    const bundleIds = bundleKeys.map((k) => k.slice("bunnybundle:".length));
    await Promise.all(bundleIds.map((id) => kvSadd(BUNDLE_INDEX_KEY, id)));

    res.status(200).json({
      ok: true,
      indexedShares: shareTokens.length,
      indexedBundles: bundleIds.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
