// The grant-exchange audit log. What matters here is as much what it does
// NOT store (a plaintext address) and what it can NOT do (break a sign-in)
// as what it records.
import test from "node:test";
import assert from "node:assert/strict";
import { setEnv, installHarness, call } from "./helpers/harness.mjs";

setEnv();
const h = installHarness();

const { recordGrantExchange, readRecentExchanges, emailFingerprint, GATE_LOG_INDEX_KEY } =
  await import("../lib/gateLog.js");
const gateLogRoute = (await import("../pages/api/gate-log.js")).default;

test.after(() => h.restore());

test("an exchange is recorded with the token, a hashed email, and the IP", async () => {
  h.reset();
  await recordGrantExchange({
    kind: "watch", token: "a".repeat(32), email: "Viewer@Example.com", ip: "198.51.100.4",
  });

  const [entry] = await readRecentExchanges();
  assert.equal(entry.kind, "watch");
  assert.equal(entry.token, "a".repeat(32));
  assert.equal(entry.ip, "198.51.100.4");
  assert.ok(entry.at > 0);
  assert.equal(entry.emailHash, emailFingerprint("viewer@example.com"), "normalized before hashing");
});

test("the plaintext address is never written anywhere", async () => {
  h.reset();
  await recordGrantExchange({ kind: "watch", token: "t", email: "secret@example.com", ip: "1.1.1.1" });

  const dump = JSON.stringify([...h.store.entries()]);
  assert.ok(!dump.includes("secret@example.com"), "the log must not become a second PII store");
  assert.ok(dump.includes(emailFingerprint("secret@example.com")));
});

test("the same address fingerprints consistently, different ones differ", async () => {
  assert.equal(emailFingerprint("a@b.com"), emailFingerprint(" A@B.com "));
  assert.notEqual(emailFingerprint("a@b.com"), emailFingerprint("c@d.com"));
});

test("entries expire rather than accumulating forever", async () => {
  h.reset();
  const key = await recordGrantExchange({ kind: "watch", token: "t", email: "a@b.com", ip: null });
  assert.equal(h.ttlFor(key), 90 * 24 * 3600, "a 90-day rolling window, not append-forever");
});

test("two exchanges in the same millisecond do not overwrite each other", async () => {
  h.reset();
  const at = Date.now();
  await recordGrantExchange({ kind: "watch", token: "one", email: "a@b.com", ip: null, at });
  await recordGrantExchange({ kind: "watch", token: "two", email: "c@d.com", ip: null, at });

  const entries = await readRecentExchanges();
  assert.equal(entries.length, 2, "a colliding key would silently destroy an audit entry");
  assert.deepEqual(entries.map((e) => e.token).sort(), ["one", "two"]);
});

test("reads come back newest first", async () => {
  h.reset();
  const base = Date.now();
  for (const [i, token] of ["oldest", "middle", "newest"].entries()) {
    await recordGrantExchange({ kind: "watch", token, email: "a@b.com", ip: null, at: base + i * 1000 });
  }
  const entries = await readRecentExchanges();
  assert.deepEqual(entries.map((e) => e.token), ["newest", "middle", "oldest"]);
});

test("a limit reads only that many, and is clamped", async () => {
  h.reset();
  const base = Date.now();
  for (let i = 0; i < 20; i++) {
    await recordGrantExchange({ kind: "watch", token: `t${i}`, email: "a@b.com", ip: null, at: base + i });
  }
  assert.equal((await readRecentExchanges(5)).length, 5);
  assert.equal((await readRecentExchanges(0)).length, 20, "a junk limit falls back to the default");
  assert.equal((await readRecentExchanges("abc")).length, 20);
});

test("expired entries are dropped from the index as they are encountered", async () => {
  h.reset();
  const key = await recordGrantExchange({ kind: "watch", token: "gone", email: "a@b.com", ip: null });
  await recordGrantExchange({ kind: "watch", token: "live", email: "a@b.com", ip: null });

  h.store.delete(key); // simulate the TTL firing
  const entries = await readRecentExchanges();

  assert.deepEqual(entries.map((e) => e.token), ["live"]);
  assert.ok(!h.sets.get(GATE_LOG_INDEX_KEY).has(key), "the orphaned index member is swept");
});

test("a store failure never throws — a broken log must not break a sign-in", async () => {
  h.reset();
  h.setKvDown(true);
  await recordGrantExchange({ kind: "watch", token: "t", email: "a@b.com", ip: null });
  h.setKvDown(false);
  // The gap is visible (nothing recorded); the exchange it was logging is not
  // affected, which is the whole point.
  assert.equal((await readRecentExchanges()).length, 0);
});

test("the admin endpoint returns exchanges newest first and rejects non-GET", async () => {
  h.reset();
  const base = Date.now();
  await recordGrantExchange({ kind: "watch", token: "older", email: "a@b.com", ip: null, at: base });
  await recordGrantExchange({ kind: "bundle", token: "bundle:x", email: "a@b.com", ip: null, at: base + 5 });

  const res = await call(gateLogRoute, { method: "GET", query: {} });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 2);
  assert.equal(res.body.exchanges[0].token, "bundle:x");
  assert.ok(!JSON.stringify(res.body).includes("a@b.com"), "the endpoint must not leak addresses either");

  assert.equal((await call(gateLogRoute, { method: "POST" })).statusCode, 405);
});
