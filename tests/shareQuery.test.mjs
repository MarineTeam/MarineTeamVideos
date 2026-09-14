import test from "node:test";
import assert from "node:assert/strict";
import { shareStatus, filterShares, paginate } from "../lib/shareQuery.js";

const HOUR = 3600 * 1000;
const share = (over = {}) => ({
  token: "t",
  email: "a@b.com",
  videoTitle: "Reel",
  createdAt: Date.now(),
  expiresAt: Date.now() + HOUR,
  revoked: false,
  ...over,
});

test("shareStatus derives state live, revoked winning over expired", () => {
  assert.equal(shareStatus(share()), "active");
  assert.equal(shareStatus(share({ expiresAt: Date.now() - 1 })), "expired");
  assert.equal(shareStatus(share({ revoked: true })), "revoked");
  assert.equal(shareStatus(share({ revoked: true, expiresAt: Date.now() - 1 })), "revoked");
});

test("shareStatus reports a spent view cap as exhausted", () => {
  assert.equal(shareStatus(share({ maxViews: 3, viewCount: 2 })), "active");
  assert.equal(shareStatus(share({ maxViews: 3, viewCount: 3 })), "exhausted");
  assert.equal(shareStatus(share({ maxViews: 3, viewCount: 9 })), "exhausted");
  // No cap means unlimited, which is how every pre-existing record behaves.
  assert.equal(shareStatus(share({ viewCount: 9999 })), "active");
});

test("filterShares selects by status", () => {
  const rows = [
    share({ token: "live" }),
    share({ token: "dead", expiresAt: Date.now() - 1 }),
    share({ token: "gone", revoked: true }),
    share({ token: "failed-send", emailFailed: true }),
  ];
  assert.deepEqual(filterShares(rows, { status: "active" }).map((r) => r.token), [
    "live",
    "failed-send",
  ]);
  assert.deepEqual(filterShares(rows, { status: "expired" }).map((r) => r.token), ["dead"]);
  assert.deepEqual(filterShares(rows, { status: "revoked" }).map((r) => r.token), ["gone"]);
  assert.deepEqual(filterShares(rows, { status: "failed" }).map((r) => r.token), ["failed-send"]);
});

test("an unknown or absent status filters nothing out", () => {
  const rows = [share(), share({ revoked: true })];
  assert.equal(filterShares(rows, {}).length, 2);
  assert.equal(filterShares(rows, { status: "all" }).length, 2);
  assert.equal(filterShares(rows, { status: "nonsense" }).length, 2);
});

test("filterShares searches email and title case-insensitively", () => {
  const rows = [
    share({ token: "1", email: "alice@corp.com", videoTitle: "Q3 Review" }),
    share({ token: "2", email: "bob@other.com", videoTitle: "Offsite" }),
  ];
  assert.deepEqual(filterShares(rows, { q: "ALICE" }).map((r) => r.token), ["1"]);
  assert.deepEqual(filterShares(rows, { q: "offsite" }).map((r) => r.token), ["2"]);
  assert.deepEqual(filterShares(rows, { q: "corp" }).map((r) => r.token), ["1"]);
  assert.equal(filterShares(rows, { q: "   " }).length, 2);
});

test("paginate clamps page and size into range", () => {
  const rows = Array.from({ length: 120 }, (_, i) => share({ token: `t${i}` }));
  const first = paginate(rows, { page: 1, pageSize: 50 });
  assert.equal(first.rows.length, 50);
  assert.equal(first.pageCount, 3);
  assert.equal(first.total, 120);
  assert.equal(first.rows[0].token, "t0");

  assert.equal(paginate(rows, { page: 3, pageSize: 50 }).rows.length, 20);
  // Out-of-range and junk inputs clamp instead of returning an empty page.
  assert.equal(paginate(rows, { page: 99, pageSize: 50 }).page, 3);
  assert.equal(paginate(rows, { page: -5, pageSize: 50 }).page, 1);
  assert.equal(paginate(rows, { page: 1, pageSize: 99999 }).pageSize, 500);
  assert.equal(paginate(rows, { page: "abc", pageSize: "abc" }).page, 1);
});

test("paginate handles an empty result set", () => {
  const empty = paginate([], {});
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.pageCount, 1);
  assert.equal(empty.total, 0);
});

test("computeAnalytics rolls up per video across all shares", async () => {
  const { computeAnalytics } = await import("../lib/shareQuery.js");
  const rows = [
    share({ videoId: "v1", videoTitle: "One", email: "a@b.com", viewCount: 3, playCount: 1, maxProgressPct: 50 }),
    share({ videoId: "v1", videoTitle: "One", email: "A@B.com", viewCount: 2, completedAt: Date.now(), maxProgressPct: 100 }),
    share({ videoId: "v2", videoTitle: "Two", email: "c@d.com", viewCount: 1 }),
  ];
  const [first, second] = computeAnalytics(rows);

  assert.equal(first.videoId, "v1");
  assert.equal(first.shares, 2);
  assert.equal(first.recipients, 1, "the same address in different cases is one recipient");
  assert.equal(first.views, 5);
  assert.equal(first.started, 2);
  assert.equal(first.completed, 1);
  assert.equal(first.completionRate, 50);
  assert.equal(first.avgProgress, 75);

  assert.equal(second.videoId, "v2");
  assert.equal(second.started, 0, "a share that was opened but never played has not started");
  assert.equal(second.completionRate, 0);
});

test("computeAnalytics handles an empty set", async () => {
  const { computeAnalytics } = await import("../lib/shareQuery.js");
  assert.deepEqual(computeAnalytics([]), []);
});
