// Route-level tests for the admin share surfaces added or changed on
// 2026-09-13: creation carrying a note and view cap, the filtered/paged
// listing, the CSV export, and the server-side analytics rollup.
import test from "node:test";
import assert from "node:assert/strict";
import { setEnv, installHarness, call } from "./helpers/harness.mjs";

setEnv();
const h = installHarness();

const shareRoute = (await import("../pages/api/share.js")).default;
const sharesRoute = (await import("../pages/api/shares.js")).default;
const exportRoute = (await import("../pages/api/shares/export.js")).default;
const analyticsRoute = (await import("../pages/api/analytics.js")).default;
const { createShareRecord } = await import("../lib/shares.js");

test.after(() => h.restore());

test("a share carries its note and view cap onto the record and into the email", async () => {
  h.reset();
  const res = await call(shareRoute, {
    body: {
      videoId: "vid-1", videoTitle: "Rough Cut", email: "viewer@example.com",
      hours: 24, maxViews: 3, note: "Timecodes are in the doc.",
    },
  });

  assert.equal(res.statusCode, 200);
  const token = res.body.link.split("/watch/")[1];
  const rec = h.record(token);
  assert.equal(rec.maxViews, 3);
  assert.equal(rec.note, "Timecodes are in the doc.");
  assert.ok(h.lastMail().text.startsWith("Timecodes are in the doc."), "the note opens the email");
  assert.ok(h.lastMail().html.includes("Timecodes are in the doc."));
});

test("an omitted cap or note leaves the field absent, not zero or empty", async () => {
  h.reset();
  const res = await call(shareRoute, {
    body: { videoId: "vid-1", videoTitle: "Rough Cut", email: "viewer@example.com", hours: 24 },
  });
  const rec = h.record(res.body.link.split("/watch/")[1]);
  assert.ok(!("maxViews" in rec), "absent means unlimited, exactly as older records behave");
  assert.ok(!("note" in rec));
});

test("a zero or negative cap is refused rather than locking everyone out", async () => {
  h.reset();
  for (const bad of [0, -5, "abc"]) {
    const res = await call(shareRoute, {
      body: { videoId: "vid-1", videoTitle: "V", email: `u${Math.random()}@example.com`, hours: 24, maxViews: bad },
    });
    const rec = h.record(res.body.link.split("/watch/")[1]);
    assert.ok(!("maxViews" in rec), `maxViews=${bad} must not be stored`);
  }
});

test("a note is escaped in the HTML body", async () => {
  h.reset();
  await call(shareRoute, {
    body: {
      videoId: "vid-1", videoTitle: "Rough Cut", email: "viewer@example.com",
      hours: 24, note: '<script>alert(1)</script>',
    },
  });
  const html = h.lastMail().html;
  assert.ok(!html.includes("<script>"), "raw script tag must never reach the HTML body");
  assert.ok(html.includes("&lt;script&gt;"));
});

test("a failed send flags the record instead of losing the share", async () => {
  h.reset();
  h.setMailFailing(true);
  const res = await call(shareRoute, {
    body: { videoId: "vid-1", videoTitle: "Rough Cut", email: "viewer@example.com", hours: 24 },
  });
  h.setMailFailing(false);

  assert.equal(res.statusCode, 500, "a single-recipient send failure still reports");
  const token = h.indexed()[0];
  assert.ok(token, "the record still exists and is indexed — the link is live");
  assert.equal(h.record(token).emailFailed, true);
  assert.ok(h.record(token).emailError);
});

// --- listing, export, analytics --------------------------------------------

async function seed() {
  h.reset();
  const mk = async (over) => {
    const { record } = await createShareRecord({
      videoId: "vid-1", videoTitle: "Rough Cut", email: "viewer@example.com",
      hours: 72, siteUrl: "https://videos.test", ...over,
    });
    return record;
  };
  const live = await mk({});
  const other = await mk({ email: "second@example.com", videoTitle: "Offsite", videoId: "vid-2" });
  const expired = await mk({ email: "old@example.com" });
  h.putRecord(expired.token, { ...h.record(expired.token), expiresAt: Date.now() - 1000 });
  const revoked = await mk({ email: "gone@example.com" });
  h.putRecord(revoked.token, { ...h.record(revoked.token), revoked: true });
  const capped = await mk({ email: "capped@example.com", maxViews: 1 });
  h.putRecord(capped.token, { ...h.record(capped.token), maxViews: 1, viewCount: 1 });
  return { live, other, expired, revoked, capped };
}

test("the listing filters by status, including the new exhausted state", async () => {
  await seed();
  const statuses = async (status) => {
    const res = await call(sharesRoute, { method: "GET", query: status ? { status } : {} });
    return res.body.shares.map((s) => s.email).sort();
  };

  assert.deepEqual(await statuses("expired"), ["old@example.com"]);
  assert.deepEqual(await statuses("revoked"), ["gone@example.com"]);
  assert.deepEqual(await statuses("exhausted"), ["capped@example.com"]);
  assert.deepEqual(await statuses("active"), ["second@example.com", "viewer@example.com"]);
  assert.equal((await statuses()).length, 5, "no filter returns everything");
});

test("the listing searches email and title, and reports both totals", async () => {
  await seed();
  const res = await call(sharesRoute, { method: "GET", query: { q: "offsite" } });
  assert.equal(res.body.shares.length, 1);
  assert.equal(res.body.shares[0].videoTitle, "Offsite");
  assert.equal(res.body.total, 1, "total reflects the filter");
  assert.equal(res.body.totalAll, 5, "totalAll reflects everything, for the 'N of M' line");
});

test("the listing pages, and clamps an out-of-range page", async () => {
  await seed();
  const p1 = await call(sharesRoute, { method: "GET", query: { page: "1", pageSize: "2" } });
  assert.equal(p1.body.shares.length, 2);
  assert.equal(p1.body.pageCount, 3);

  const p99 = await call(sharesRoute, { method: "GET", query: { page: "99", pageSize: "2" } });
  assert.equal(p99.body.page, 3, "an out-of-range page clamps instead of returning nothing");
  assert.ok(p99.body.shares.length > 0);
});

test("the export honours filters, is unpaged, and neutralizes formulas", async () => {
  h.reset();
  await createShareRecord({
    videoId: "vid-1", videoTitle: '=HYPERLINK("http://evil","click")',
    email: "viewer@example.com", hours: 72, siteUrl: "https://videos.test", note: "+1234",
  });
  for (let i = 0; i < 60; i++) {
    await createShareRecord({
      videoId: "vid-2", videoTitle: "Bulk", email: `u${i}@example.com`,
      hours: 72, siteUrl: "https://videos.test",
    });
  }

  const res = await call(exportRoute, { method: "GET", query: {} });
  assert.equal(res.headers["Content-Type"], "text/csv; charset=utf-8");
  assert.match(res.headers["Content-Disposition"], /attachment; filename="shares-\d{4}-\d{2}-\d{2}\.csv"/);

  const lines = res.body.split("\r\n");
  assert.equal(lines.length, 62, "header + 61 rows: the export is never paged");
  assert.ok(res.body.includes(`"'=HYPERLINK`), "a formula-shaped title must be prefixed as text");
  assert.ok(res.body.includes(`"'+1234"`), "and so must a formula-shaped note");

  const filtered = await call(exportRoute, { method: "GET", query: { q: "Bulk" } });
  assert.equal(filtered.body.split("\r\n").length, 61, "header + 60 matching rows");
});

test("analytics rolls up across every share, not just one page", async () => {
  h.reset();
  for (let i = 0; i < 60; i++) {
    await createShareRecord({
      videoId: "vid-1", videoTitle: "Rough Cut", email: `u${i}@example.com`,
      hours: 72, siteUrl: "https://videos.test",
    });
  }
  const res = await call(analyticsRoute, { method: "GET", query: {} });
  const row = res.body.analytics.find((a) => a.videoId === "vid-1");
  assert.equal(row.shares, 60, "must count all 60, not the 50-row page size");
  assert.equal(row.recipients, 60);
});

test("listing and export reject non-GET", async () => {
  h.reset();
  assert.equal((await call(sharesRoute, { method: "POST" })).statusCode, 405);
  assert.equal((await call(exportRoute, { method: "POST" })).statusCode, 405);
  assert.equal((await call(analyticsRoute, { method: "POST" })).statusCode, 405);
});
