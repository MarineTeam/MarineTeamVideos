import { kvGet, kvDel, kvSrem, kvSmembers } from "../../lib/kv";
import { SHARE_INDEX_KEY } from "../../lib/shares";
import { BUNDLE_INDEX_KEY } from "../../lib/bundles";
import { withApiMonitor } from "../../lib/withMonitor";

async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    // Reads both index sets (SMEMBERS) rather than KEYS-scanning the whole
    // keyspace — see pages/api/backfill-index.js if a store had records
    // before either index existed.
    const shareTokens = await kvSmembers(SHARE_INDEX_KEY);
    const shareRecords = await Promise.all(shareTokens.map((t) => kvGet(`bunnyshare:${t}`)));
    const shareEntries = shareTokens.map((token, i) => ({ token, record: shareRecords[i] }));
    const shareToDelete = shareEntries.filter(
      ({ record }) => record && (record.revoked || Date.now() > record.expiresAt)
    );
    // Self-heal: a token present in the index whose record is already gone
    // (e.g. an interrupted delete elsewhere) — drop it from the index too,
    // so it stops costing a wasted GET on every future listing/cleanup.
    const shareIndexOrphans = shareEntries.filter(({ record }) => !record);

    // Bundle records (lib/bundles.js) have no revoked flag of their own —
    // they're a grouping list, not a share — so a bundle retires when
    // EITHER its own expiresAt passes OR every member it lists has gone
    // dead (revoked, expired, or its bunnyshare: record deleted entirely),
    // whichever comes first. Without the second condition, revoking (or
    // permanently deleting) every video in a bundle leaves a fully live,
    // gate-able bundle record behind — its own expiresAt tracks the MAX of
    // every member ever added (and only grows via Extend), so it can
    // linger long after it has nothing left to show. Uses the
    // already-computed shareEntries above (this run's live/dead
    // determination), not a fresh lookup.
    const liveShareTokens = new Set(
      shareEntries
        .filter(({ record }) => record && !record.revoked && Date.now() < record.expiresAt)
        .map(({ token }) => token)
    );

    const bundleIds = await kvSmembers(BUNDLE_INDEX_KEY);
    const bundleRecords = await Promise.all(bundleIds.map((id) => kvGet(`bunnybundle:${id}`)));
    const bundleEntries = bundleIds.map((id, i) => ({ id, record: bundleRecords[i] }));
    const bundleToDelete = bundleEntries.filter(({ record }) => {
      if (!record) return false;
      const expired = Date.now() > record.expiresAt;
      const allMembersDead = record.tokens.every((t) => !liveShareTokens.has(t));
      return expired || allMembersDead;
    });
    const bundleIndexOrphans = bundleEntries.filter(({ record }) => !record);

    await Promise.all([
      ...shareToDelete.map(({ token }) =>
        Promise.all([kvDel(`bunnyshare:${token}`), kvSrem(SHARE_INDEX_KEY, token)])
      ),
      ...bundleToDelete.map(({ id }) =>
        Promise.all([kvDel(`bunnybundle:${id}`), kvSrem(BUNDLE_INDEX_KEY, id)])
      ),
      ...shareIndexOrphans.map(({ token }) => kvSrem(SHARE_INDEX_KEY, token)),
      ...bundleIndexOrphans.map(({ id }) => kvSrem(BUNDLE_INDEX_KEY, id)),
    ]);

    res.status(200).json({ deleted: shareToDelete.length + bundleToDelete.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
