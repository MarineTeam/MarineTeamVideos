// The bundle listing page's access decision — the gate's second entrance,
// previously untestable because it lived inside a JSX file (roadmap item
// (r), bundle half). The property that matters most here: ONE verification
// unlocks the whole bundle by minting ordinary per-video cookies, never by
// weakening what /watch accepts.
process.env.GATE_SECRET = "bundle-access-test-secret";

import test from "node:test";
import assert from "node:assert/strict";
import {
  decideBundleAccess,
  bundleCookieName,
  bundleToken,
  buildBundleCookie,
} from "../lib/bundleAccess.js";
import { buildGateCookie, cookieName, EXPIRED_NOTICE } from "../lib/watchAccess.js";
import { signGrant, verifyGrant } from "../lib/gate.js";

const BUNDLE_ID = "b".repeat(32);
const T1 = "1".repeat(32);
const T2 = "2".repeat(32);
const HOUR = 3600 * 1000;
const NOW = Date.now(); // anchored to the real clock — verifyGrant checks it

const bundle = (over = {}) => ({
  id: BUNDLE_ID,
  email: "viewer@example.com",
  tokens: [T1, T2],
  createdAt: NOW - HOUR,
  expiresAt: NOW + 72 * HOUR,
  ...over,
});

const member = (token, over = {}) => ({
  token,
  record: {
    token,
    videoId: `vid-${token.slice(0, 1)}`,
    videoTitle: `Video ${token.slice(0, 1)}`,
    email: "viewer@example.com",
    createdAt: NOW - HOUR,
    expiresAt: NOW + 48 * HOUR,
    revoked: false,
    ...over,
  },
});

const MEMBERS = [member(T1), member(T2)];

const decide = (over = {}) =>
  decideBundleAccess({
    bundleId: BUNDLE_ID,
    bundle: bundle(),
    loadMembers: async () => MEMBERS,
    now: NOW,
    ...over,
  });

const magicLink = (over = {}) =>
  signGrant({
    token: bundleToken(BUNDLE_ID),
    email: "viewer@example.com",
    expiresAt: NOW + 15 * 60 * 1000,
    ...over,
  });

const listingCookie = (over = {}) => ({
  [bundleCookieName(BUNDLE_ID)]: signGrant({
    token: bundleToken(BUNDLE_ID),
    email: "viewer@example.com",
    expiresAt: NOW + 72 * HOUR,
    ...over,
  }),
});

// --- refusals ---------------------------------------------------------------

test("a missing or expired bundle is refused", async () => {
  assert.equal((await decide({ bundle: null })).reason, "Link not found.");
  const expired = await decide({ bundle: bundle({ expiresAt: NOW - 1 }) });
  assert.equal(expired.kind, "invalid");
  assert.match(expired.reason, /expired/);
});

test("a geo-blocked visitor never reaches the gate or a cookie", async () => {
  const d = await decide({ geoAllowed: false, grant: magicLink() });
  assert.equal(d.kind, "invalid");
  assert.match(d.reason, /region/);
  assert.ok(!d.setCookies);
});

test("a bundle has no revoked flag of its own — only expiry and membership", async () => {
  // Guards architecture-contract 5.1a: adding a `revoked` field to a bundle
  // record must not silently start gating on it.
  const d = await decide({ bundle: bundle({ revoked: true }) });
  assert.equal(d.kind, "need-email", "a stray revoked flag must be ignored, not honoured");
});

// --- the exchange: one verification, many cookies ----------------------------

test("a valid magic link mints the listing cookie AND one per live member", async () => {
  const grant = magicLink();
  const d = await decide({ grant, secure: true });

  assert.equal(d.kind, "exchange");
  assert.equal(d.redirectTo, `/bundle/${BUNDLE_ID}`);
  assert.equal(d.spend.grant, grant);
  assert.equal(d.setCookies.length, 3, "one listing cookie + two member cookies");

  const [listing, ...videos] = d.setCookies;
  assert.match(listing, new RegExp(`^gate_bundle_${BUNDLE_ID}=`));
  assert.match(listing, new RegExp(`Path=/bundle/${BUNDLE_ID}`));
  assert.match(listing, /HttpOnly/);
  assert.match(listing, /Secure/);

  assert.match(videos[0], new RegExp(`^gate_${T1}=`));
  assert.match(videos[0], new RegExp(`Path=/watch/${T1}`));
  assert.match(videos[1], new RegExp(`^gate_${T2}=`));
});

test("the per-video cookies are byte-identical to what the watch page mints", async () => {
  // This is the architecture contract's claim that a bundle exchange mints
  // "the same format the per-video gate already produces". Both now come
  // from buildGateCookie, so the claim holds by construction — this asserts
  // it stays that way.
  const d = await decide({ grant: magicLink(), secure: true });
  const minted = d.setCookies.find((c) => c.startsWith(`gate_${T1}=`));
  const value = decodeURIComponent(minted.split(";")[0].split("=").slice(1).join("="));

  const expected = buildGateCookie({
    token: T1,
    grant: value,
    maxAgeSeconds: 48 * 3600,
    secure: true,
  });
  assert.equal(minted, expected);
});

test("each minted per-video cookie is a valid grant for its own share only", async () => {
  const d = await decide({ grant: magicLink() });
  const forT1 = d.setCookies.find((c) => c.startsWith(`gate_${T1}=`));
  const value = decodeURIComponent(forT1.split(";")[0].split("=").slice(1).join("="));

  assert.ok(verifyGrant(value, { token: T1 }), "must verify on its own share");
  assert.equal(verifyGrant(value, { token: T2 }), null, "must not verify on a sibling");
});

test("a dead member is skipped rather than breaking the exchange", async () => {
  const d = await decide({
    grant: magicLink(),
    loadMembers: async () => [member(T1), { token: T2, record: null }],
  });
  assert.equal(d.setCookies.length, 2, "listing cookie + the one live member");
  assert.ok(!d.setCookies.some((c) => c.startsWith(`gate_${T2}=`)));
});

test("an insecure request gets no Secure flag on any cookie", async () => {
  const d = await decide({ grant: magicLink(), secure: false });
  for (const c of d.setCookies) assert.ok(!/Secure/.test(c));
});

// --- single-use -------------------------------------------------------------

test("a REPLAYED bundle link is refused and looks like a stale one", async () => {
  const replayed = await decide({ grant: magicLink(), isSpent: async () => true });
  const garbage = await decide({ grant: "not-a-real-grant" });
  const stale = await decide({ grant: magicLink({ expiresAt: NOW - 1 }) });

  assert.equal(replayed.kind, "need-email");
  assert.equal(replayed.notice, EXPIRED_NOTICE);
  assert.ok(!replayed.setCookies, "a replay must not re-mint the whole cookie set");
  assert.deepEqual(replayed, garbage);
  assert.deepEqual(replayed, stale);
});

test("no refused path ever asks for the grant to be spent", async () => {
  for (const d of [
    await decide({ grant: "garbage" }),
    await decide({ grant: magicLink(), isSpent: async () => true }),
    await decide({ grant: magicLink(), geoAllowed: false }),
    await decide({ grant: magicLink(), bundle: bundle({ expiresAt: NOW - 1 }) }),
  ]) {
    assert.ok(!d.spend, `${d.kind} must not spend a grant`);
  }
});

test("a video grant cannot open a bundle, and a bundle grant cannot open a video", async () => {
  const videoGrant = signGrant({ token: T1, email: "viewer@example.com", expiresAt: NOW + HOUR });
  const d = await decide({ grant: videoGrant });
  assert.equal(d.kind, "need-email", "a real video token must not verify as a bundle");

  const bg = magicLink();
  assert.equal(verifyGrant(bg, { token: T1 }), null, "and the reverse must also fail");
});

// --- the listing ------------------------------------------------------------

test("a valid listing cookie shows every member with its LIVE status", async () => {
  const d = await decide({
    cookies: listingCookie(),
    loadMembers: async () => [
      member(T1),
      member(T2, { revoked: true }),
    ],
  });

  assert.equal(d.kind, "authorized");
  assert.deepEqual(d.items.map((i) => i.status), ["active", "revoked"]);
  assert.equal(d.items[0].link, `/watch/${T1}`);
  assert.equal(d.items[0].videoTitle, "Video 1");
});

test("member status is re-read live, never from the bundle record", async () => {
  // The bundle lists both tokens and knows nothing about their state; an
  // expired member must show as expired without the bundle changing at all.
  const d = await decide({
    cookies: listingCookie(),
    loadMembers: async () => [member(T1, { expiresAt: NOW - 1 }), member(T2)],
  });
  assert.deepEqual(d.items.map((i) => i.status), ["expired", "active"]);
});

test("a deleted member simply disappears from the listing", async () => {
  const d = await decide({
    cookies: listingCookie(),
    loadMembers: async () => [member(T1), { token: T2, record: null }],
  });
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].token, T1);
});

test("an expired or foreign listing cookie does not authorize", async () => {
  assert.equal((await decide({ cookies: listingCookie({ expiresAt: NOW - 1 }) })).kind, "need-email");
  assert.equal(
    (await decide({ cookies: { [bundleCookieName(BUNDLE_ID)]: signGrant({ token: bundleToken("c".repeat(32)), email: "v@e.com", expiresAt: NOW + HOUR }) } })).kind,
    "need-email",
    "a cookie for another bundle must not authorize this one"
  );
});

test("no cookie and no grant asks for the email", async () => {
  const d = await decide({});
  assert.equal(d.kind, "need-email");
  assert.ok(!d.notice, "a first visit carries no expiry notice");
});

test("the cookie names and paths have not drifted", async () => {
  assert.equal(bundleCookieName(BUNDLE_ID), `gate_bundle_${BUNDLE_ID}`);
  assert.equal(bundleToken(BUNDLE_ID), `bundle:${BUNDLE_ID}`);
  assert.equal(
    buildBundleCookie({ bundleId: BUNDLE_ID, grant: "g", maxAgeSeconds: 60, secure: false }),
    `gate_bundle_${BUNDLE_ID}=g; HttpOnly; Path=/bundle/${BUNDLE_ID}; SameSite=Lax; Max-Age=60`
  );
  assert.notEqual(bundleCookieName(BUNDLE_ID), cookieName(BUNDLE_ID), "names must not collide");
});
