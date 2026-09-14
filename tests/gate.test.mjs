// Gate crypto: the security core of the email gate. These assertions mirror
// the long-standing manual self-test described in
// .claude/skills/bunny-sharing-diagnostics, so the same properties are now
// checked automatically on every `npm test` run.
process.env.GATE_SECRET = "test-secret-value-for-unit-tests";

import test from "node:test";
import assert from "node:assert/strict";
import { signGrant, verifyGrant, grantFingerprint, normalizeEmail } from "../lib/gate.js";

const TOKEN = "a".repeat(32);
const future = () => Date.now() + 60_000;

test("round-trips a valid grant", () => {
  const grant = signGrant({ token: TOKEN, email: "Person@Example.com", expiresAt: future() });
  const payload = verifyGrant(grant, { token: TOKEN });
  assert.ok(payload, "expected a valid grant to verify");
  assert.equal(payload.t, TOKEN);
  assert.equal(payload.e, "person@example.com", "email must be normalized into the payload");
});

test("rejects an expired grant", () => {
  const grant = signGrant({ token: TOKEN, email: "a@b.com", expiresAt: Date.now() - 1 });
  assert.equal(verifyGrant(grant, { token: TOKEN }), null);
});

test("rejects a grant bound to a different token", () => {
  const grant = signGrant({ token: TOKEN, email: "a@b.com", expiresAt: future() });
  assert.equal(verifyGrant(grant, { token: "b".repeat(32) }), null);
});

// Tamper at the BYTE level, not the character level. A base64url string's
// final character carries unused low bits (a 32-byte HMAC encodes to 43
// chars, the last holding only 4 significant bits), so two different final
// characters can decode to identical bytes — flipping one is not a tamper
// at all, and a test that does so silently passes for the wrong reason.
// This version decodes, flips a byte, re-encodes, and asserts the bytes
// really changed before relying on the result.
function tamperSignature(sig) {
  const raw = Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const flipped = Buffer.from(raw);
  flipped[0] ^= 0xff;
  assert.notDeepEqual(flipped, raw, "the tamper must actually change the decoded bytes");
  return flipped.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

test("rejects a tampered signature", () => {
  const grant = signGrant({ token: TOKEN, email: "a@b.com", expiresAt: future() });
  const [body, sig] = grant.split(".");
  assert.equal(verifyGrant(`${body}.${tamperSignature(sig)}`, { token: TOKEN }), null);
});

test("rejects a signature of the wrong length", () => {
  const grant = signGrant({ token: TOKEN, email: "a@b.com", expiresAt: future() });
  const [body, sig] = grant.split(".");
  assert.equal(verifyGrant(`${body}.${sig.slice(0, 20)}`, { token: TOKEN }), null);
  assert.equal(verifyGrant(`${body}.${sig}AAAA`, { token: TOKEN }), null);
});

test("rejects a tampered payload", () => {
  const grant = signGrant({ token: TOKEN, email: "a@b.com", expiresAt: future() });
  const [, sig] = grant.split(".");
  // Deliberately a DIFFERENT recipient than the signed one, so the forged
  // body can never coincidentally equal the original and pass on its own
  // signature.
  const forged = Buffer.from(JSON.stringify({ t: TOKEN, e: "attacker@evil.com", x: future() }))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert.equal(verifyGrant(`${forged}.${sig}`, { token: TOKEN }), null);
});

test("never throws on malformed input", () => {
  for (const bad of [null, undefined, "", "nodot", "a.b", 42, {}, "....", "a.".repeat(50)]) {
    assert.equal(verifyGrant(bad, { token: TOKEN }), null);
  }
});

test("a bundle grant can never verify against a real video token", () => {
  const bundleGrant = signGrant({ token: `bundle:${TOKEN}`, email: "a@b.com", expiresAt: future() });
  assert.equal(verifyGrant(bundleGrant, { token: TOKEN }), null);
  assert.ok(verifyGrant(bundleGrant, { token: `bundle:${TOKEN}` }));
});

test("grantFingerprint is stable, hex, and not the grant itself", () => {
  const grant = signGrant({ token: TOKEN, email: "a@b.com", expiresAt: future() });
  const fp = grantFingerprint(grant);
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(fp, grantFingerprint(grant), "must be deterministic");
  assert.notEqual(fp, grant);
  assert.notEqual(fp, grantFingerprint(grant + "x"));
});

test("normalizeEmail trims and lowercases", () => {
  assert.equal(normalizeEmail("  Foo@BAR.com "), "foo@bar.com");
  assert.equal(normalizeEmail(null), "");
});
