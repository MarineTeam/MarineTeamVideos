// Route-level tests for /api/watch/track — public, grant-gated, and since
// 2026-09-13 it can send an admin email. The email is the sensitive part: a
// public route that mails must be bounded, and this one is bounded three
// ways (valid tracking grant, active share, never-played-before).
import test from "node:test";
import assert from "node:assert/strict";
import { setEnv, installHarness, call } from "./helpers/harness.mjs";

setEnv({ ADMIN_NOTIFY_EMAIL: "owner@videos.test" });
const h = installHarness();

const track = (await import("../pages/api/watch/track.js")).default;
const { createShareRecord } = await import("../lib/shares.js");
const { signGrant } = await import("../lib/gate.js");
const { saveSettings } = await import("../lib/settings.js");

test.after(() => h.restore());

async function setup({ notify = true } = {}) {
  h.reset();
  await saveSettings({ notifyOnFirstPlay: notify });
  const { record } = await createShareRecord({
    videoId: "vid-1", videoTitle: "Rough Cut", email: "viewer@example.com",
    hours: 72, siteUrl: "https://videos.test",
  });
  h.clearMail();
  const auth = signGrant({ token: record.token, email: record.email, expiresAt: Date.now() + 3600_000 });
  return { record, auth };
}

test("a play is recorded and notifies the owner exactly once, ever", async () => {
  const { record, auth } = await setup();

  await call(track, { body: { token: record.token, auth, event: "play" } });
  assert.equal(h.record(record.token).playCount, 1);
  assert.equal(h.mail.length, 1, "first play notifies");
  assert.ok(h.lastMail().text.includes("viewer@example.com"));
  assert.ok(h.lastMail().subject.includes("Rough Cut"));

  await call(track, { body: { token: record.token, auth, event: "play" } });
  assert.equal(h.record(record.token).playCount, 2, "the play is still counted");
  assert.equal(h.mail.length, 1, "but a second play must NOT notify again");
});

test("the notification is off unless the setting is on", async () => {
  const { record, auth } = await setup({ notify: false });
  await call(track, { body: { token: record.token, auth, event: "play" } });
  assert.equal(h.record(record.token).playCount, 1, "tracking still works");
  assert.equal(h.mail.length, 0, "no mail when the toggle is off");
});

test("a mailer failure never fails the track call", async () => {
  const { record, auth } = await setup();
  h.setMailFailing(true);

  const res = await call(track, { body: { token: record.token, auth, event: "play" } });
  h.setMailFailing(false);

  assert.equal(res.statusCode, 200, "tracking is fire-and-forget; mail must not break it");
  assert.deepEqual(res.body, { ok: true });
  assert.equal(h.record(record.token).playCount, 1, "and the play is still recorded");
});

test("counters cannot be inflated without a valid grant", async () => {
  const { record } = await setup();

  const noAuth = await call(track, { body: { token: record.token, event: "play" } });
  assert.equal(noAuth.statusCode, 400);

  const badAuth = await call(track, { body: { token: record.token, auth: "forged.grant", event: "play" } });
  assert.equal(badAuth.statusCode, 403);

  const otherShare = signGrant({ token: "f".repeat(32), email: "x@y.com", expiresAt: Date.now() + 3600_000 });
  const wrongShare = await call(track, { body: { token: record.token, auth: otherShare, event: "play" } });
  assert.equal(wrongShare.statusCode, 403, "a grant for another share must not track this one");

  assert.equal(h.record(record.token).playCount, undefined, "nothing was recorded");
  assert.equal(h.mail.length, 0, "and nothing was mailed");
});

test("a revoked or expired share cannot be tracked or notified", async () => {
  const { record, auth } = await setup();
  h.putRecord(record.token, { ...h.record(record.token), revoked: true });

  const res = await call(track, { body: { token: record.token, auth, event: "play" } });
  assert.equal(res.statusCode, 403);
  assert.equal(h.mail.length, 0);
});

test("progress and completion are monotonic and do not notify", async () => {
  const { record, auth } = await setup();
  await call(track, { body: { token: record.token, auth, event: "play" } });
  h.clearMail();

  await call(track, { body: { token: record.token, auth, event: "progress", progressPct: 75 } });
  await call(track, { body: { token: record.token, auth, event: "progress", progressPct: 25 } });
  assert.equal(h.record(record.token).maxProgressPct, 75, "progress must never go backwards");

  await call(track, { body: { token: record.token, auth, event: "ended", progressPct: 100 } });
  const rec = h.record(record.token);
  assert.equal(rec.maxProgressPct, 100);
  assert.ok(rec.completedAt);
  assert.equal(h.mail.length, 0, "only the first PLAY notifies, never progress or completion");
});

test("an unknown event is rejected", async () => {
  const { record, auth } = await setup();
  const res = await call(track, { body: { token: record.token, auth, event: "nonsense" } });
  assert.equal(res.statusCode, 400);
});
