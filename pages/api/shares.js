import { kvGet, kvSmembers } from "../../lib/kv";
import { baseUrl, SHARE_INDEX_KEY } from "../../lib/shares";
import { bundleLinksForTokens } from "../../lib/bundles";
import { withApiMonitor } from "../../lib/withMonitor";

async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();
  try {
    // Reads the index set (SMEMBERS) rather than KEYS-scanning the whole
    // keyspace — see pages/api/backfill-index.js if this returns fewer
    // shares than expected on a store that had records before the index
    // existed.
    const tokens = await kvSmembers(SHARE_INDEX_KEY);
    const records = await Promise.all(tokens.map((t) => kvGet(`bunnyshare:${t}`)));
    const shares = records.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);

    const siteUrl = baseUrl(req);
    const bundleLinks = await bundleLinksForTokens(shares.map((s) => s.token), siteUrl);
    const sharesWithBundle = shares.map((s) =>
      bundleLinks[s.token] ? { ...s, bundleLink: bundleLinks[s.token] } : s
    );

    res.status(200).json({ shares: sharesWithBundle });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
