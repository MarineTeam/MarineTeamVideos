// The createdAt-ordered share index (roadmap item (m)). Two things are under
// test: that the unfiltered listing actually became bounded, and — more
// important — that every way the ordered index can be unusable degrades to
// the old full read rather than to an empty table.
import test from "node:test";
import assert from "node:assert/strict";
import { setEnv, installHarness, call } from "./helpers/harness.mjs";

setEnv();
const h = installHarness();

const sharesRoute = (await import("../pages/api/shares.js")).default;
const cleanupRoute = (await import("../pages/api/cleanup.js")).default;
const backfillRoute = (await import("../pages/api/backfill-index.js")).default;
const revokePermanent = (await import("../pages/api/revoke-permanent.js")).default;
const { loadSharePage } = await import("../lib/shareQuery.js");
const { createShareRecord, SHARE_BY_CREATED_KEY, SHARE_INDEX_KEY } = await import("../lib/shares.js");

test.after(() => h.restore());

async function seed(n, { spacingMs = 1000 } = {}) {
  h.reset();
  const tokens = [];
  for (let i = 0; i < n; i++) {
    const { record } = await createShareRecord({
      videoId: "vid-1", videoTitle: `Video ${i}`, email: `u${i}@example.com`,
      hours: 72, siteUrl: "https://videos.test",
    });
    // Space createdAt so ordering is unambiguous.
    h.putRecord(record.token, { ...h.record(record.token), createdAt: 1_700_000_000_000 + i * spacingMs });
    h.zsets.get(SHARE_BY_CREATED_KEY).set(record.token, 1_700_000_000_000 + i * spacingMs);
    tokens.push(record.token);
  }
  return tokens;
}

test("creating a share indexes it in BOTH indexes", async () => {
  h.reset();
  const { record } = await createShareRecord({
    videoId: "v", videoTitle: "V", email: "a@b.com", hours: 72, siteUrl: "https://videos.test",
  });
  assert.deepEqual(h.indexed(), [record.token]);
  assert.deepEqual(h.ordered(), [record.token]);
});

test("the unfiltered listing reads ONE page of records, not all of them", async () => {
  await seed(60);
  h.clearOps();

  const res = await call(sharesRoute, { method: "GET", query: { page: "1", pageSize: "10" } });

  assert.equal(res.body.shares.length, 10);
  assert.equal(res.body.total, 60);
  // The whole point of the feature: GETs are bounded by the page size, not
  // by how many shares exist. 10 records + settings-ish reads, nowhere near 60.
  assert.ok(h.countOps("get") <= 15, `expected ~10 record reads, got ${h.countOps("get")}`);
  assert.ok(h.countOps("zrange") >= 1, "served from the ordered index");
});

test("the unfiltered listing is newest first across pages", async () => {
  await seed(25);
  const p1 = await call(sharesRoute, { method: "GET", query: { page: "1", pageSize: "10" } });
  const p3 = await call(sharesRoute, { method: "GET", query: { page: "3", pageSize: "10" } });

  assert.equal(p1.body.shares[0].videoTitle, "Video 24", "newest first");
  assert.equal(p1.body.shares[9].videoTitle, "Video 15");
  assert.equal(p3.body.shares.length, 5, "last page is partial");
  assert.equal(p3.body.shares[4].videoTitle, "Video 0", "oldest last");
});

// --- the fallback, which is the load-bearing safety property ---------------

test("an UN-BACKFILLED deployment still shows every share, never an empty table", async () => {
  await seed(12);
  h.zsets.delete(SHARE_BY_CREATED_KEY); // the state of any store that upgraded without backfilling

  const page = await loadSharePage({ page: 1, pageSize: 50 });
  assert.equal(page.ordered, false, "must fall back");
  assert.equal(page.rows.length, 12, "and still show everything — this is the 30ecd7f lesson");

  const res = await call(sharesRoute, { method: "GET", query: {} });
  assert.equal(res.body.shares.length, 12);
});

test("a PARTIALLY backfilled index falls back rather than hiding the remainder", async () => {
  const tokens = await seed(10);
  // Simulate a backfill that got through only half the records.
  for (const t of tokens.slice(5)) h.zsets.get(SHARE_BY_CREATED_KEY).delete(t);

  const page = await loadSharePage({ page: 1, pageSize: 50 });
  assert.equal(page.ordered, false, "a short ordered index is not trustworthy");
  assert.equal(page.rows.length, 10, "all ten still listed");
});

test("an unavailable ordered index falls back instead of failing the listing", async () => {
  await seed(8);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    // Reject only the sorted-set commands, as a provider that does not accept
    // this command shape would (roadmap item (m)'s known deploy risk).
    if (/\/z(range|card)\//.test(String(url))) throw new Error("ERR unknown command");
    return realFetch(url, opts);
  };

  const page = await loadSharePage({ page: 1, pageSize: 50 });
  globalThis.fetch = realFetch;

  assert.equal(page.ordered, false);
  assert.equal(page.rows.length, 8, "the admin table degrades to slow, never to wrong");
});

// --- filtering keeps the old path -------------------------------------------

test("a filtered query still reads everything and stays correct", async () => {
  const tokens = await seed(20);
  h.putRecord(tokens[0], { ...h.record(tokens[0]), revoked: true });

  const res = await call(sharesRoute, { method: "GET", query: { status: "revoked" } });
  assert.equal(res.body.shares.length, 1);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.totalAll, 20, "the unfiltered total is still reported");
});

test("a search query still matches across every share, not just page one", async () => {
  await seed(60);
  const res = await call(sharesRoute, { method: "GET", query: { q: "Video 3" } });
  // Video 3, 30..39 — all beyond the first page of an ordered read.
  assert.ok(res.body.total >= 11, `expected matches past page one, got ${res.body.total}`);
});

// --- deletes keep the two indexes in step -----------------------------------

test("permanent delete removes the token from BOTH indexes", async () => {
  const [token] = await seed(3);
  h.putRecord(token, { ...h.record(token), revoked: true });

  await call(revokePermanent, { body: { token } });

  assert.ok(!h.indexed().includes(token));
  assert.ok(!h.ordered().includes(token), "a stale rank would serve a row that no longer exists");
});

test("cleanup removes swept tokens from BOTH indexes", async () => {
  const tokens = await seed(4);
  h.putRecord(tokens[0], { ...h.record(tokens[0]), expiresAt: Date.now() - 1000 });
  h.putRecord(tokens[1], { ...h.record(tokens[1]), revoked: true });

  const res = await call(cleanupRoute, { method: "POST" });
  assert.equal(res.body.deleted, 2);

  for (const t of tokens.slice(0, 2)) {
    assert.ok(!h.indexed().includes(t));
    assert.ok(!h.ordered().includes(t));
  }
  assert.equal(h.ordered().length, 2, "the live ones stay");
});

test("backfill seeds the ordered index from existing records", async () => {
  await seed(5);
  h.zsets.delete(SHARE_BY_CREATED_KEY); // pre-existing store, no ordered index

  const res = await call(backfillRoute, { method: "POST" });
  assert.equal(res.body.indexedShares, 5);
  assert.equal(h.ordered().length, 5);

  const page = await loadSharePage({ page: 1, pageSize: 50 });
  assert.equal(page.ordered, true, "after backfill the fast path engages");
  assert.equal(page.rows[0].videoTitle, "Video 4", "and the order is right");
});

test("backfill is idempotent", async () => {
  await seed(3);
  await call(backfillRoute, { method: "POST" });
  await call(backfillRoute, { method: "POST" });
  assert.equal(h.ordered().length, 3, "re-running must not duplicate members");
});
