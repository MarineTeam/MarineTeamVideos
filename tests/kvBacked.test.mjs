// Tests for the two KV-backed hardening helpers, against an in-memory stand-in
// for the Upstash REST API. The stub speaks the same URL shapes lib/kv.js
// builds, so these exercise the real helpers and the real kv layer — only the
// network is faked.
import test from "node:test";
import assert from "node:assert/strict";

process.env.KV_REST_API_URL = "https://kv.test";
process.env.KV_REST_API_TOKEN = "test-token";
process.env.GATE_SECRET = "test-secret-value-for-unit-tests";

const store = new Map();
const originalFetch = globalThis.fetch;

globalThis.fetch = async (url) => {
  const { pathname, searchParams } = new URL(url);
  const [, op, rawKey, rawValue] = pathname.split("/");
  const key = decodeURIComponent(rawKey || "");
  let result = null;

  if (op === "set") {
    store.set(key, decodeURIComponent(rawValue || ""));
    if (searchParams.has("EX")) store.set(`__ttl__${key}`, Number(searchParams.get("EX")));
    result = "OK";
  } else if (op === "get") {
    result = store.has(key) ? store.get(key) : null;
  } else if (op === "del") {
    store.delete(key);
    result = 1;
  } else if (op === "smembers") {
    result = [];
  }

  return { ok: true, json: async () => ({ result }) };
};

const { isGrantSpent, markGrantSpent } = await import("../lib/singleUse.js");
const { allowRequestFromIp, clientIp } = await import("../lib/rateLimit.js");
const { signGrant, grantFingerprint } = await import("../lib/gate.js");

test.after(() => {
  globalThis.fetch = originalFetch;
});

test("a magic-link grant is spendable exactly once", async () => {
  store.clear();
  const grant = signGrant({ token: "t".repeat(32), email: "a@b.com", expiresAt: Date.now() + 60_000 });

  assert.equal(await isGrantSpent(grant), false, "a fresh grant must not read as spent");
  await markGrantSpent(grant, Date.now() + 60_000);
  assert.equal(await isGrantSpent(grant), true, "a replayed grant must read as spent");

  // The stored key is the hash, never the credential itself.
  const keys = [...store.keys()].filter((k) => !k.startsWith("__ttl__"));
  assert.deepEqual(keys, [`gateused:${grantFingerprint(grant)}`]);
  assert.ok(!keys[0].includes(grant), "the raw grant must never be stored");
});

test("spending one grant does not spend another", async () => {
  store.clear();
  const a = signGrant({ token: "a".repeat(32), email: "a@b.com", expiresAt: Date.now() + 60_000 });
  const b = signGrant({ token: "b".repeat(32), email: "a@b.com", expiresAt: Date.now() + 60_000 });
  await markGrantSpent(a, Date.now() + 60_000);
  assert.equal(await isGrantSpent(a), true);
  assert.equal(await isGrantSpent(b), false);
});

test("the spent marker expires with the grant, and an already-dead grant stores nothing", async () => {
  store.clear();
  const grant = signGrant({ token: "c".repeat(32), email: "a@b.com", expiresAt: Date.now() + 30_000 });
  await markGrantSpent(grant, Date.now() + 30_000);
  const ttl = store.get(`__ttl__gateused:${grantFingerprint(grant)}`);
  assert.ok(ttl > 0 && ttl <= 30, `expected a TTL near the grant's remaining life, got ${ttl}`);

  store.clear();
  await markGrantSpent(grant, Date.now() - 1000);
  assert.equal(store.size, 0, "an expired grant needs no marker — it fails verification anyway");
});

test("single-use checks fail OPEN when KV errors", async () => {
  store.clear();
  const saved = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("KV down");
  };
  // Never lock out a recipient holding a valid grant because KV blipped.
  assert.equal(await isGrantSpent("anything"), false);
  await markGrantSpent("anything", Date.now() + 60_000); // must not throw
  globalThis.fetch = saved;
});

test("clientIp prefers the first x-forwarded-for entry", () => {
  assert.equal(clientIp({ headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } }), "1.2.3.4");
  assert.equal(clientIp({ headers: { "x-real-ip": "9.9.9.9" } }), "9.9.9.9");
  assert.equal(clientIp({ headers: {} }), "");
});

test("per-IP limiting allows up to the cap then blocks", async () => {
  store.clear();
  const req = { headers: { "x-forwarded-for": "203.0.113.7" } };
  for (let i = 0; i < 3; i++) {
    assert.equal(await allowRequestFromIp(req, 3), true, `request ${i + 1} should be allowed`);
  }
  assert.equal(await allowRequestFromIp(req, 3), false, "the 4th request should be blocked");
});

test("per-IP limiting buckets each IP separately", async () => {
  store.clear();
  const a = { headers: { "x-forwarded-for": "203.0.113.1" } };
  const b = { headers: { "x-forwarded-for": "203.0.113.2" } };
  assert.equal(await allowRequestFromIp(a, 1), true);
  assert.equal(await allowRequestFromIp(a, 1), false);
  assert.equal(await allowRequestFromIp(b, 1), true, "one IP's quota must not affect another's");
});

test("per-IP limiting fails OPEN with no usable IP or a KV error", async () => {
  store.clear();
  // Local dev and non-proxied hosts send no IP header — they must not be
  // silently rate limited into oblivion.
  assert.equal(await allowRequestFromIp({ headers: {} }, 1), true);
  assert.equal(await allowRequestFromIp({ headers: {} }, 1), true);

  const saved = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("KV down");
  };
  assert.equal(await allowRequestFromIp({ headers: { "x-forwarded-for": "1.1.1.1" } }, 1), true);
  globalThis.fetch = saved;
});
