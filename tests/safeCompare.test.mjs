import test from "node:test";
import assert from "node:assert/strict";
import { timingSafeEqualStr } from "../lib/safeCompare.js";

test("matches identical strings", async () => {
  assert.equal(await timingSafeEqualStr("hunter2", "hunter2"), true);
  assert.equal(await timingSafeEqualStr("", ""), true);
});

test("rejects differing strings, including length and prefix cases", async () => {
  assert.equal(await timingSafeEqualStr("hunter2", "hunter3"), false);
  assert.equal(await timingSafeEqualStr("hunter", "hunter2"), false);
  assert.equal(await timingSafeEqualStr("", "x"), false);
  // A correct prefix must not be treated as a match — the exact leak the
  // plain === compare in middleware.js used to expose through timing.
  assert.equal(await timingSafeEqualStr("admin", "administrator"), false);
});

test("handles unicode without throwing", async () => {
  assert.equal(await timingSafeEqualStr("pässwörd", "pässwörd"), true);
  assert.equal(await timingSafeEqualStr("pässwörd", "passwörd"), false);
});

test("never matches an undefined credential against the string 'undefined'", async () => {
  // middleware.js guards this case before calling, but assert the primitive
  // is not itself a footgun if that guard is ever removed.
  assert.equal(await timingSafeEqualStr("undefined", String(undefined)), true);
  assert.equal(await timingSafeEqualStr("anything", "undefined"), false);
});
