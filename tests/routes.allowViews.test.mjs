// Route-level tests for raising a share's view cap — the administration gap
// that shipped alongside view caps in 5eb7245 (roadmap item (p)). The
// property under test is as much about what it REFUSES as what it does.
import test from "node:test";
import assert from "node:assert/strict";
import { setEnv, installHarness, call } from "./helpers/harness.mjs";

setEnv();
const h = installHarness();

const allowViews = (await import("../pages/api/share/allow-views.js")).default;
const allowViewsBulk = (await import("../pages/api/share/allow-views-bulk.js")).default;
const watchPage = await import("../lib/watchAccess.js");
const { createShareRecord } = await import("../lib/shares.js");
const { getSettings } = await import("../lib/settings.js");

test.after(() => h.restore());

async function capped({ maxViews = 2, viewCount = 2, revoked = false } = {}) {
  h.reset();
  const { record } = await createShareRecord({
    videoId: "vid-1", videoTitle: "Rough Cut", email: "viewer@example.com",
    hours: 72, siteUrl: "https://videos.test", maxViews,
  });
  h.putRecord(record.token, { ...h.record(record.token), viewCount, revoked });
  return record.token;
}

test("raising the cap makes a used-up link work again, same token", async () => {
  const token = await capped({ maxViews: 2, viewCount: 2 });

  // Before: the gate refuses it.
  const before = await watchPage.decideWatchAccess({
    token, record: h.record(token), settings: await getSettings(),
  });
  assert.equal(before.kind, "invalid");
  assert.match(before.reason, /view limit/);

  const res = await call(allowViews, { body: { token, views: 3 } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.maxViews, 5);

  // After: the same token, unchanged, opens the gate again.
  const after = await watchPage.decideWatchAccess({
    token, record: h.record(token), settings: await getSettings(),
  });
  assert.equal(after.kind, "need-email", "the link is live again");
  assert.equal(h.record(token).token, token, "and it is the SAME token — no re-share");
});

test("the view count is preserved, never reset", async () => {
  const token = await capped({ maxViews: 2, viewCount: 2 });
  await call(allowViews, { body: { token, views: 3 } });

  const rec = h.record(token);
  assert.equal(rec.viewCount, 2, "the audit trail of actual opens must survive");
  assert.equal(rec.maxViews, 5, "only the cap moves");
  assert.equal(rec.maxViews - rec.viewCount, 3, "exactly the granted number of further opens");
});

test("a share that ran past its cap still gets exactly the granted number", async () => {
  // Defensive: concurrent renders could in principle push viewCount past the
  // cap. The grant is measured from wherever the share actually stands.
  const token = await capped({ maxViews: 2, viewCount: 7 });
  await call(allowViews, { body: { token, views: 3 } });
  assert.equal(h.record(token).maxViews, 10);
});

test("a revoked share is refused — this must never double as Restore", async () => {
  const token = await capped({ revoked: true });
  const res = await call(allowViews, { body: { token, views: 3 } });

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /revoked/);
  assert.equal(h.record(token).maxViews, 2, "the cap must be untouched");
  assert.equal(h.record(token).revoked, true, "and it stays revoked");
});

test("an uncapped share is refused — imposing a cap is a different action", async () => {
  h.reset();
  const { record } = await createShareRecord({
    videoId: "vid-1", videoTitle: "Rough Cut", email: "viewer@example.com",
    hours: 72, siteUrl: "https://videos.test",
  });
  const res = await call(allowViews, { body: { token: record.token, views: 3 } });

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /no view limit/);
  assert.ok(!("maxViews" in h.record(record.token)), "an unlimited share must stay unlimited");
});

test("non-positive and non-whole grants are refused", async () => {
  const token = await capped();
  for (const views of [0, -5, 1.5, "abc"]) {
    const res = await call(allowViews, { body: { token, views } });
    assert.notEqual(res.statusCode, 200, `views=${views} must be refused`);
    assert.equal(h.record(token).maxViews, 2, `views=${views} must not change the cap`);
  }
});

test("a missing token is a 404", async () => {
  h.reset();
  const res = await call(allowViews, { body: { token: "f".repeat(32), views: 3 } });
  assert.equal(res.statusCode, 404);
});

test("a missing field is a 400", async () => {
  const token = await capped();
  assert.equal((await call(allowViews, { body: { token } })).statusCode, 400);
  assert.equal((await call(allowViews, { body: { views: 3 } })).statusCode, 400);
  assert.equal((await call(allowViews, { method: "GET", body: {} })).statusCode, 405);
});

test("bulk raises what it can and reports the rest without failing the batch", async () => {
  h.reset();
  const mk = async (over) => {
    const { record } = await createShareRecord({
      videoId: "vid-1", videoTitle: "V", email: `${Math.random()}@example.com`,
      hours: 72, siteUrl: "https://videos.test", ...over,
    });
    return record.token;
  };
  const a = await mk({ maxViews: 2 });
  const b = await mk({ maxViews: 4 });
  const revoked = await mk({ maxViews: 2 });
  h.putRecord(revoked, { ...h.record(revoked), revoked: true });
  const uncapped = await mk({});

  const res = await call(allowViewsBulk, {
    body: { tokens: [a, b, revoked, uncapped, "f".repeat(32)], views: 5 },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.succeeded.map((r) => r.maxViews).sort((x, y) => x - y), [7, 9]);
  assert.equal(res.body.failures.length, 3, "revoked, uncapped and missing are each reported");
  assert.equal(h.record(a).maxViews, 7, "the good ones still applied");
  assert.equal(h.record(revoked).maxViews, 2, "the revoked one untouched");
});

test("bulk rejects a malformed request outright", async () => {
  h.reset();
  assert.equal((await call(allowViewsBulk, { body: { tokens: [], views: 5 } })).statusCode, 400);
  assert.equal((await call(allowViewsBulk, { body: { tokens: ["x"] } })).statusCode, 400);
  assert.equal((await call(allowViewsBulk, { method: "GET", body: {} })).statusCode, 405);
});
