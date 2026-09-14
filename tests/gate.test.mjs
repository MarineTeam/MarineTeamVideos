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

test("rejects a tampered signature", () => {
  const grant = signGrant({ token: TOKEN, email: "a@b.com", expiresAt: future() });
  const [body, sig] = grant.split(".");
  const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
  assert.equal(verifyGrant(`${body}.${flipped}`, { token: TOKEN }), null);
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
