// The watch-page access decision — previously untestable because it lived
// inside a JSX file (roadmap item (r)). This is the gate: possession of the
// URL plus control of the inbox, single-use magic links, and every reason a
// link may be refused.
process.env.GATE_SECRET = "watch-access-test-secret";

import test from "node:test";
import assert from "node:assert/strict";
import { decideWatchAccess, buildGateCookie, cookieName, EXPIRED_NOTICE } from "../lib/watchAccess.js";
import { signGrant } from "../lib/gate.js";

const TOKEN = "a".repeat(32);
const HOUR = 3600 * 1000;
// Anchored to the real clock, not a fixed past instant: verifyGrant checks
// grant expiry against Date.now() internally, so a NOW in the past would
// make every signed grant in this file read as already expired and the
// tests would pass for the wrong reason (the exact failure mode recorded in
// failure-archaeology Episode 12). Every assertion below is relative to
// NOW, so anchoring it here changes nothing else.
const NOW = Date.now();

const SETTINGS = {
  watermarkDefault: false,
  watermarkExemptEmails: [],
  watermarkExemptDomains: [],
  watermarkByVideo: {},
};

const share = (over = {}) => ({
  token: TOKEN,
  videoId: "vid-1",
  videoTitle: "Rough Cut",
  email: "viewer@example.com",
  createdAt: NOW - HOUR,
  expiresAt: NOW + 72 * HOUR,
  revoked: false,
  ...over,
});

const decide = (over = {}) =>
  decideWatchAccess({ token: TOKEN, record: share(), settings: SETTINGS, now: NOW, ...over });

const magicLink = (over = {}) =>
  signGrant({ token: TOKEN, email: "viewer@example.com", expiresAt: NOW + 15 * 60 * 1000, ...over });

// --- refusals ---------------------------------------------------------------

test("a missing record is refused without revealing anything", async () => {
  const d = await decide({ record: null });
  assert.equal(d.kind, "invalid");
  assert.equal(d.reason, "Link not found.");
  assert.ok(!d.canRequestAccess, "there is no address to verify an asker against");
});

test("a revoked share is refused and is NOT appealable", async () => {
  const d = await decide({ record: share({ revoked: true }) });
  assert.equal(d.kind, "invalid");
  assert.match(d.reason, /revoked/);
  assert.ok(!d.canRequestAccess, "revocation is a decision, not something to appeal");
});

test("an expired share is refused but IS appealable", async () => {
  const d = await decide({ record: share({ expiresAt: NOW - 1 }) });
  assert.equal(d.kind, "invalid");
  assert.equal(d.reason, "This link has expired.");
  assert.equal(d.canRequestAccess, true);
});

test("revoked beats expired: a revoked, expired share is never appealable", async () => {
  const d = await decide({ record: share({ revoked: true, expiresAt: NOW - 1 }) });
  assert.match(d.reason, /revoked/);
  assert.ok(!d.canRequestAccess);
});

test("a spent view cap is refused before the email gate is ever offered", async () => {
  const atCap = await decide({ record: share({ maxViews: 3, viewCount: 3 }) });
  assert.equal(atCap.kind, "invalid");
  assert.match(atCap.reason, /view limit/);

  const underCap = await decide({ record: share({ maxViews: 3, viewCount: 2 }) });
  assert.equal(underCap.kind, "need-email", "under the cap the gate still opens");
});

test("no cap means unlimited, however many views a record carries", async () => {
  const d = await decide({ record: share({ viewCount: 9999 }) });
  assert.equal(d.kind, "need-email");
});

test("a geo-blocked visitor never reaches the email gate", async () => {
  const d = await decide({ geoAllowed: false, grant: magicLink() });
  assert.equal(d.kind, "invalid");
  assert.match(d.reason, /region/);
  assert.ok(!d.setCookie, "and certainly never gets a cookie");
});

// --- the exchange, and the single-use guarantee ------------------------------

test("a valid magic link mints the cookie, asks to spend the grant, and redirects", async () => {
  const grant = magicLink();
  const d = await decide({ grant, secure: true });

  assert.equal(d.kind, "exchange");
  assert.equal(d.redirectTo, `/watch/${TOKEN}`);
  assert.equal(d.spend.grant, grant, "the caller is told to spend this exact grant");

  assert.match(d.setCookie, new RegExp(`^gate_${TOKEN}=`));
  assert.match(d.setCookie, /HttpOnly/);
  assert.match(d.setCookie, new RegExp(`Path=/watch/${TOKEN}`));
  assert.match(d.setCookie, /SameSite=Lax/);
  assert.match(d.setCookie, /Secure/);
  assert.match(d.setCookie, /Max-Age=259200/, "cookie lives until the share expires");
});

test("an insecure request gets no Secure flag", async () => {
  const d = await decide({ grant: magicLink(), secure: false });
  assert.ok(!/Secure/.test(d.setCookie));
});

test("a REPLAYED magic link is refused, and is indistinguishable from a stale one", async () => {
  const grant = magicLink();

  const replayed = await decide({ grant, isSpent: async () => true });
  const garbage = await decide({ grant: "not-a-real-grant" });
  const stale = await decide({ grant: magicLink({ expiresAt: NOW - 1 }) });

  assert.equal(replayed.kind, "need-email");
  assert.equal(replayed.notice, EXPIRED_NOTICE);
  assert.ok(!replayed.setCookie, "a replay must never mint a cookie");
  assert.deepEqual(replayed, garbage, "replay must look exactly like an invalid grant");
  assert.deepEqual(replayed, stale, "and exactly like an expired one");
});

test("the grant is only spent on the cookie-setting path", async () => {
  // A prefetcher that hits a page which grants nothing must not burn the link.
  for (const d of [
    await decide({ grant: "garbage" }),
    await decide({ grant: magicLink(), isSpent: async () => true }),
    await decide({ grant: magicLink(), geoAllowed: false }),
    await decide({ grant: magicLink(), record: share({ revoked: true }) }),
  ]) {
    assert.ok(!d.spend, `${d.kind} must not ask for a grant to be spent`);
  }
});

test("a grant for another share cannot open this one", async () => {
  const other = signGrant({ token: "b".repeat(32), email: "viewer@example.com", expiresAt: NOW + HOUR });
  const d = await decide({ grant: other });
  assert.equal(d.kind, "need-email");
  assert.ok(!d.setCookie);
});

// --- the authorized path ----------------------------------------------------

function cookieFor(over = {}) {
  return {
    [cookieName(TOKEN)]: signGrant({
      token: TOKEN,
      email: "viewer@example.com",
      expiresAt: NOW + 72 * HOUR,
      ...over,
    }),
  };
}

test("a valid cookie authorizes and counts the view", async () => {
  const d = await decide({ cookies: cookieFor() });
  assert.equal(d.kind, "authorized");
  assert.equal(d.videoId, "vid-1");
  assert.equal(d.viewUpdate.viewCount, 1);
  assert.equal(d.viewUpdate.firstViewedAt, NOW);
  assert.equal(d.viewUpdate.lastViewedAt, NOW);
});

test("a repeat view increments without resetting the first-seen time", async () => {
  const d = await decide({
    record: share({ viewCount: 4, firstViewedAt: NOW - 10 * HOUR }),
    cookies: cookieFor(),
  });
  assert.equal(d.viewUpdate.viewCount, 5);
  assert.equal(d.viewUpdate.firstViewedAt, NOW - 10 * HOUR, "first view must never move");
});

test("an expired or foreign cookie does not authorize", async () => {
  const expired = await decide({ cookies: cookieFor({ expiresAt: NOW - 1 }) });
  assert.equal(expired.kind, "need-email");

  const foreign = await decide({
    cookies: { [cookieName(TOKEN)]: signGrant({ token: "b".repeat(32), email: "x@y.com", expiresAt: NOW + HOUR }) },
  });
  assert.equal(foreign.kind, "need-email");
});

test("the tracking grant is token-bound and capped at six hours", async () => {
  const d = await decide({ cookies: cookieFor() });
  const { verifyGrant } = await import("../lib/gate.js");
  const payload = verifyGrant(d.trackAuth, { token: TOKEN });
  assert.ok(payload, "the page's own tracking grant must verify");
  assert.equal(payload.x, NOW + 6 * HOUR, "capped at 6h when the share outlives that");

  const shortShare = await decide({
    record: share({ expiresAt: NOW + HOUR }),
    cookies: cookieFor({ expiresAt: NOW + HOUR }),
  });
  const shortPayload = verifyGrant(shortShare.trackAuth, { token: TOKEN });
  assert.equal(shortPayload.x, NOW + HOUR, "or at share expiry when that is sooner");
});

test("the watermark decision reaches the player, and exemptions win", async () => {
  const on = await decide({
    settings: { ...SETTINGS, watermarkDefault: true },
    cookies: cookieFor(),
  });
  assert.equal(on.watermarkText, "viewer@example.com");

  const exempt = await decide({
    settings: { ...SETTINGS, watermarkDefault: true, watermarkExemptEmails: ["viewer@example.com"] },
    cookies: cookieFor(),
  });
  assert.equal(exempt.watermarkText, null);

  const perShareOff = await decide({
    settings: { ...SETTINGS, watermarkDefault: true },
    record: share({ watermark: false }),
    cookies: cookieFor(),
  });
  assert.equal(perShareOff.watermarkText, null);
});

// --- backward compatibility (change-control class (c) evidence) --------------

test("a record with ONLY the original fields still works end to end", async () => {
  // Exactly the 2026-07 shape: no viewCount, watermark, maxViews, note,
  // lastPositionSec or durationSec. Nothing may assume those exist.
  const legacy = {
    token: TOKEN,
    videoId: "vid-1",
    videoTitle: "Rough Cut",
    email: "viewer@example.com",
    createdAt: NOW - HOUR,
    expiresAt: NOW + 72 * HOUR,
    revoked: false,
  };

  const gate = await decide({ record: legacy });
  assert.equal(gate.kind, "need-email");
  assert.equal(gate.title, "Rough Cut");

  const exchange = await decide({ record: legacy, grant: magicLink() });
  assert.equal(exchange.kind, "exchange", "an old record must still accept a magic link");

  const authorized = await decide({ record: legacy, cookies: cookieFor() });
  assert.equal(authorized.kind, "authorized", "and an old cookie must still play");
  assert.equal(authorized.viewUpdate.viewCount, 1, "tracking starts cleanly on an old record");
  assert.equal(authorized.resumeSec, 0);
  assert.equal(authorized.durationSec, 0);
  assert.equal(authorized.watermarkText, null);
});

test("the cookie name and path have not drifted", async () => {
  // These are compatibility surface: a change here logs out every live viewer.
  assert.equal(cookieName(TOKEN), `gate_${TOKEN}`);
  assert.equal(
    buildGateCookie({ token: TOKEN, grant: "g", maxAgeSeconds: 60, secure: false }),
    `gate_${TOKEN}=g; HttpOnly; Path=/watch/${TOKEN}; SameSite=Lax; Max-Age=60`
  );
});
