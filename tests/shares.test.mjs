import test from "node:test";
import assert from "node:assert/strict";
import { parseEmails, normalizeNote, baseUrl } from "../lib/shares.js";

test("parseEmails fans out every separator form", () => {
  // A comma-joined string must never survive into a record's email field —
  // records stored that way can never pass the email gate (the incident
  // behind this function).
  assert.deepEqual(parseEmails("a@b.com, c@d.com"), ["a@b.com", "c@d.com"]);
  assert.deepEqual(parseEmails("a@b.com;c@d.com"), ["a@b.com", "c@d.com"]);
  assert.deepEqual(parseEmails("a@b.com c@d.com"), ["a@b.com", "c@d.com"]);
  assert.deepEqual(parseEmails(["a@b.com, c@d.com", "e@f.com"]), [
    "a@b.com",
    "c@d.com",
    "e@f.com",
  ]);
});

test("parseEmails dedupes and drops non-addresses", () => {
  assert.deepEqual(parseEmails("a@b.com, a@b.com, notanemail, "), ["a@b.com"]);
  assert.deepEqual(parseEmails(""), []);
  assert.deepEqual(parseEmails(null), []);
});

test("normalizeNote trims, caps length, and treats blank as absent", () => {
  assert.equal(normalizeNote("  hello  "), "hello");
  assert.equal(normalizeNote(""), "");
  assert.equal(normalizeNote(null), "");
  assert.equal(normalizeNote("   "), "");
  assert.equal(normalizeNote("x".repeat(900)).length, 500);
});

test("baseUrl fails loudly when SITE_URL is unset", () => {
  const saved = process.env.SITE_URL;
  delete process.env.SITE_URL;
  // Never fall back to the request Host header: that was the host-header
  // poisoning bug, not the fix for one.
  assert.throws(() => baseUrl({ headers: { host: "evil.example.com" } }), /SITE_URL is not set/);
  process.env.SITE_URL = "https://videos.example.com";
  assert.equal(baseUrl({ headers: { host: "evil.example.com" } }), "https://videos.example.com");
  if (saved === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = saved;
});
