import test from "node:test";
import assert from "node:assert/strict";
import { resolveWatermark, getVideoWatermark } from "../lib/settings.js";

const base = {
  watermarkDefault: false,
  watermarkExemptEmails: ["exempt@corp.com"],
  watermarkExemptDomains: ["internal.com"],
  watermarkByVideo: {},
};

test("exemption by email beats every other layer", () => {
  assert.equal(
    resolveWatermark({
      settings: { ...base, watermarkDefault: true },
      recipientEmail: "EXEMPT@corp.com",
      shareWatermark: true,
      videoWatermark: true,
    }),
    false
  );
});

test("exemption by domain beats every other layer", () => {
  assert.equal(
    resolveWatermark({
      settings: base,
      recipientEmail: "anyone@internal.com",
      shareWatermark: true,
    }),
    false
  );
});

test("per-share override beats per-video and global", () => {
  assert.equal(
    resolveWatermark({ settings: { ...base, watermarkDefault: true }, recipientEmail: "a@b.com", shareWatermark: false, videoWatermark: true }),
    false
  );
  assert.equal(
    resolveWatermark({ settings: base, recipientEmail: "a@b.com", shareWatermark: true, videoWatermark: false }),
    true
  );
});

test("per-video override beats the global default", () => {
  assert.equal(
    resolveWatermark({ settings: { ...base, watermarkDefault: true }, recipientEmail: "a@b.com", videoWatermark: false }),
    false
  );
});

test("falls through to the global default when nothing overrides", () => {
  assert.equal(resolveWatermark({ settings: base, recipientEmail: "a@b.com" }), false);
  assert.equal(
    resolveWatermark({ settings: { ...base, watermarkDefault: true }, recipientEmail: "a@b.com" }),
    true
  );
});

test("an absent per-video key means inherit, not off", () => {
  const settings = { ...base, watermarkDefault: true, watermarkByVideo: { vid1: false } };
  assert.equal(getVideoWatermark(settings, "vid1"), false);
  assert.equal(getVideoWatermark(settings, "unknown-video"), undefined);
  assert.equal(
    resolveWatermark({ settings, recipientEmail: "a@b.com", videoWatermark: getVideoWatermark(settings, "unknown-video") }),
    true
  );
});
