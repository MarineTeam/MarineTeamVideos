// Route-level tests for the email gate: the uniform-response contract, the
// per-IP dampener, and the single-use magic-link exchange.
//
// These exercise the actual handlers and the actual getServerSideProps, not
// the helpers underneath them — the coverage gap the 2026-09-13 batch
// shipped with (failure-archaeology Episode 12).
import test from "node:test";
import assert from "node:assert/strict";
import { setEnv, installHarness, call, fingerprint } from "./helpers/harness.mjs";

setEnv();
const h = installHarness();

const requestLink = (await import("../pages/api/watch/request-link.js")).default;
const shareRoute = (await import("../pages/api/share.js")).default;
const { createShareRecord } = await import("../lib/shares.js");
const { verifyGrant } = await import("../lib/gate.js");

// NOT COVERED HERE: the grant->cookie exchange itself, which lives in
// getServerSideProps inside pages/watch/[token].js. That file contains JSX,
// so plain Node cannot import it, and this repo has no JSX transform
// available (only @swc/helpers, a runtime shim, is installed). Testing it
// would require either a new build dependency or extracting the
// access-decision logic out of the React file into lib/ — a deliberate
// change to the most security-sensitive page, which should not ride along
// in a test commit. Tracked as roadmap item (r). What IS covered below: the
// grant this route mints, and (in tests/kvBacked.test.mjs) the spend/replay
// primitives the exchange calls.

test.after(() => h.restore());

async function makeShare(over = {}) {
  const { record } = await createShareRecord({
    videoId: "vid-1",
    videoTitle: "Rough Cut",
    email: "viewer@example.com",
    hours: 72,
    siteUrl: "https://videos.test",
    ...over,
  });
  return record;
}

function grantFromMail(h) {
  const body = h.lastMail().text;
  const m = body.match(/grant=([^\s&]+)/);
  assert.ok(m, `no grant in mail body: ${body}`);
  return decodeURIComponent(m[1]);
}

// --- anti-enumeration (invariant 4) ----------------------------------------

test("every request-link outcome is byte-identical", async () => {
  h.reset();
  const rec = await makeShare();
  h.clearMail();

  // Each branch from a DIFFERENT IP so the per-IP counter can't confound.
  const ip = (n) => ({ headers: { "x-forwarded-for": `203.0.113.${n}` } });

  const results = {
    success: await call(requestLink, { body: { token: rec.token, email: "viewer@example.com" }, ...ip(1) }),
    wrongEmail: await call(requestLink, { body: { token: rec.token, email: "nobody@example.com" }, ...ip(2) }),
    unknownToken: await call(requestLink, { body: { token: "f".repeat(32), email: "viewer@example.com" }, ...ip(3) }),
    throttled: await call(requestLink, { body: { token: rec.token, email: "viewer@example.com" }, ...ip(4) }),
  };

  const revoked = await makeShare({ email: "revoked@example.com" });
  h.putRecord(revoked.token, { ...h.record(revoked.token), revoked: true });
  results.revoked = await call(requestLink, { body: { token: revoked.token, email: "revoked@example.com" }, ...ip(5) });

  const expired = await makeShare({ email: "expired@example.com" });
  h.putRecord(expired.token, { ...h.record(expired.token), expiresAt: Date.now() - 1000 });
  results.expired = await call(requestLink, { body: { token: expired.token, email: "expired@example.com" }, ...ip(6) });

  const baseline = fingerprint(results.success);
  for (const [name, res] of Object.entries(results)) {
    assert.equal(fingerprint(res), baseline, `${name} is distinguishable from success`);
  }
  assert.equal(results.success.statusCode, 200);
});

test("only the matching email actually produces a magic link", async () => {
  h.reset();
  const rec = await makeShare();
  h.clearMail();

  await call(requestLink, { body: { token: rec.token, email: "nobody@example.com" }, headers: { "x-forwarded-for": "203.0.113.20" } });
  assert.equal(h.mail.length, 0, "a non-matching email must never send");

  await call(requestLink, { body: { token: rec.token, email: "VIEWER@example.com" }, headers: { "x-forwarded-for": "203.0.113.21" } });
  assert.equal(h.mail.length, 1, "a matching email (any case) must send exactly one");
  assert.equal(h.lastMail().to, "viewer@example.com", "mail goes to the normalized typed address");
});

test("the per-share throttle blocks a rapid second request without changing the response", async () => {
  h.reset();
  const rec = await makeShare();
  h.clearMail();
  const ip = { headers: { "x-forwarded-for": "203.0.113.30" } };

  const first = await call(requestLink, { body: { token: rec.token, email: "viewer@example.com" }, ...ip });
  const second = await call(requestLink, { body: { token: rec.token, email: "viewer@example.com" }, ...ip });

  assert.equal(h.mail.length, 1, "the throttled second request must not send");
  assert.equal(fingerprint(second), fingerprint(first));
  assert.equal(h.ttlFor(`gatethrottle:${rec.token}`), 30);
});

// --- per-IP dampener --------------------------------------------------------

test("the per-IP cap stops sends after 10/min and stays uniform", async () => {
  h.reset();
  const ip = { headers: { "x-forwarded-for": "198.51.100.77" } };
  const shares = [];
  for (let i = 0; i < 12; i++) shares.push(await makeShare({ email: `r${i}@example.com` }));
  h.clearMail();

  const responses = [];
  for (let i = 0; i < 12; i++) {
    responses.push(await call(requestLink, { body: { token: shares[i].token, email: `r${i}@example.com` }, ...ip }));
  }

  assert.equal(h.mail.length, 10, `expected exactly 10 sends before the cap, got ${h.mail.length}`);
  const baseline = fingerprint(responses[0]);
  for (const r of responses) assert.equal(fingerprint(r), baseline, "a rate-limited response must be indistinguishable");
});

test("one IP's exhausted quota does not affect another IP", async () => {
  h.reset();
  const shares = [];
  for (let i = 0; i < 11; i++) shares.push(await makeShare({ email: `q${i}@example.com` }));
  h.clearMail();

  for (let i = 0; i < 11; i++) {
    await call(requestLink, { body: { token: shares[i].token, email: `q${i}@example.com` }, headers: { "x-forwarded-for": "198.51.100.90" } });
  }
  assert.equal(h.mail.length, 10);

  await call(requestLink, { body: { token: shares[10].token, email: "q10@example.com" }, headers: { "x-forwarded-for": "198.51.100.91" } });
  assert.equal(h.mail.length, 11, "a different IP must still be served");
});

// --- properties of the minted grant ----------------------------------------

test("the emailed grant is bound to its own share and short-lived", async () => {
  h.reset();
  const a = await makeShare({ email: "a@example.com" });
  const b = await makeShare({ email: "b@example.com" });
  h.clearMail();

  await call(requestLink, { body: { token: a.token, email: "a@example.com" }, headers: { "x-forwarded-for": "192.0.2.12" } });
  const grant = grantFromMail(h);

  const payload = verifyGrant(grant, { token: a.token });
  assert.ok(payload, "the emailed grant must verify against its own share");
  assert.equal(payload.e, "a@example.com", "the grant carries the normalized recipient");
  assert.equal(verifyGrant(grant, { token: b.token }), null, "it must not verify against another share");

  const remainingMs = payload.x - Date.now();
  assert.ok(remainingMs > 0 && remainingMs <= 15 * 60 * 1000, `expected a <=15min TTL, got ${remainingMs}ms`);
});

test("the magic link points at this app's SITE_URL, never a request Host", async () => {
  h.reset();
  const rec = await makeShare();
  h.clearMail();
  await call(requestLink, {
    body: { token: rec.token, email: "viewer@example.com" },
    headers: { "x-forwarded-for": "192.0.2.13", host: "evil.example.com" },
  });
  const body = h.lastMail().text;
  assert.ok(body.includes("https://videos.test/watch/"), "link must be built from SITE_URL");
  assert.ok(!body.includes("evil.example.com"), "a spoofed Host must never reach an emailed link");
});
