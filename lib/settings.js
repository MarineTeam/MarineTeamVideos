import { kvGet, kvSet } from "./kv";
import { normalizeEmail } from "./gate";

// Global, admin-editable app settings. Stored in its OWN KV namespace
// (`bunnysettings:global`) that can never collide with `bunnyshare:*` or
// `bunnybundle:*`. Everything here is additive to the app: a deployment that
// never writes settings reads the DEFAULTS below and behaves exactly as it
// did before this file existed (watermark off, no exemptions).
const SETTINGS_KEY = "bunnysettings:global";

const DEFAULTS = {
  // Global watermark default applied to any share/video that doesn't set its
  // own explicit override. Off by default — watermarking is opt-in.
  watermarkDefault: false,
  // Viewers who are NEVER watermarked, however the other settings resolve.
  // This is how "exempt users such as admins" is modelled in an app that has
  // no user accounts or roles: by the verified recipient email.
  watermarkExemptEmails: [],
  // Same, by domain (e.g. "yourcompany.com" exempts every internal viewer).
  watermarkExemptDomains: [],
  // Per-video watermark overrides, keyed by Bunny video id -> boolean. Videos
  // have no KV record of their own (they're fetched live from Bunny), so their
  // override lives here. A present key is an explicit on/off for that video; an
  // absent key means "inherit the global default". Sits between the per-share
  // override and the global default in resolveWatermark below.
  watermarkByVideo: {},
  // Runtime ON/OFF switch for the recipient-facing geo whitelist (/watch,
  // /bundle). The country list itself is NOT stored here — it's read from
  // the GEO_WHITELIST env var (lib/geo.js: recipientGeoWhitelist()), same
  // reasoning as the admin whitelist below: keeping the list itself in an
  // env var (not the admin-editable KV settings) means it can only be
  // changed from your hosting dashboard, never mistyped into a form and
  // saved instantly. Off by default (inert, even if the env var is set).
  geoWhitelistEnabled: false,
  // Runtime ON/OFF switch for the ADMIN-surface geo whitelist (middleware.js).
  // The country list itself is NOT stored here — it's read from the
  // ADMIN_GEO_WHITELIST env var (lib/geo.js: adminGeoWhitelist()) so it can
  // never be edited from inside the admin UI it protects. This toggle just
  // lets an admin turn that enforcement on/off at runtime without a
  // redeploy. Off by default (inert, even if the env var happens to be set).
  adminGeoWhitelistEnabled: false,
  // Email the admin the first time a recipient actually PLAYS a share
  // (not merely opens the page — see the view-vs-playback distinction in
  // pages/api/watch/track.js). Off by default; needs ADMIN_NOTIFY_EMAIL set
  // to have anywhere to send to, so a deployment that sets neither is
  // completely unaffected. Fires at most once per share, ever, because it
  // keys off the record's firstPlayedAt being absent.
  notifyOnFirstPlay: false,
};

export async function getSettings() {
  const stored = (await kvGet(SETTINGS_KEY)) || {};
  return { ...DEFAULTS, ...stored };
}

// Persists a settings patch. Only the known keys are written, each normalized,
// so a malformed POST body can't inject arbitrary fields into the record.
export async function saveSettings(patch = {}) {
  const current = await getSettings();
  const next = {
    watermarkDefault:
      patch.watermarkDefault === undefined
        ? current.watermarkDefault
        : !!patch.watermarkDefault,
    watermarkExemptEmails: normalizeEmailList(
      patch.watermarkExemptEmails === undefined
        ? current.watermarkExemptEmails
        : patch.watermarkExemptEmails
    ),
    watermarkExemptDomains: normalizeDomainList(
      patch.watermarkExemptDomains === undefined
        ? current.watermarkExemptDomains
        : patch.watermarkExemptDomains
    ),
    // Preserved untouched when the patch doesn't include it (e.g. a save from
    // the Settings form), so per-video overrides set from the Videos grid
    // aren't clobbered by an unrelated settings save.
    watermarkByVideo: sanitizeVideoMap(
      patch.watermarkByVideo === undefined
        ? current.watermarkByVideo
        : patch.watermarkByVideo
    ),
    geoWhitelistEnabled:
      patch.geoWhitelistEnabled === undefined
        ? current.geoWhitelistEnabled
        : !!patch.geoWhitelistEnabled,
    notifyOnFirstPlay:
      patch.notifyOnFirstPlay === undefined
        ? current.notifyOnFirstPlay
        : !!patch.notifyOnFirstPlay,
    adminGeoWhitelistEnabled:
      patch.adminGeoWhitelistEnabled === undefined
        ? current.adminGeoWhitelistEnabled
        : !!patch.adminGeoWhitelistEnabled,
  };
  await kvSet(SETTINGS_KEY, next);
  return next;
}

// Sets or clears one video's watermark override without disturbing the rest of
// the settings record. `choice`: true (always) / false (never) / null|undefined
// (clear -> inherit the global default).
export async function setVideoWatermark(videoId, choice) {
  const current = await getSettings();
  const map = { ...current.watermarkByVideo };
  if (choice === true || choice === false) map[String(videoId)] = choice;
  else delete map[String(videoId)];
  return saveSettings({ watermarkByVideo: map });
}

// The explicit per-video override for a video, or undefined if none is set.
export function getVideoWatermark(settings, videoId) {
  const v = settings.watermarkByVideo && settings.watermarkByVideo[String(videoId)];
  return typeof v === "boolean" ? v : undefined;
}

function sanitizeVideoMap(v) {
  if (!v || typeof v !== "object") return {};
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "boolean") out[String(k)] = val;
  }
  return out;
}

function toList(v) {
  return Array.isArray(v) ? v : String(v || "").split(/[,;\s]+/);
}

function normalizeEmailList(v) {
  return [...new Set(toList(v).map((e) => normalizeEmail(e)).filter((e) => e.includes("@")))];
}

function normalizeDomainList(v) {
  return [
    ...new Set(
      toList(v)
        .map((d) => String(d || "").trim().toLowerCase().replace(/^@/, ""))
        .filter(Boolean)
    ),
  ];
}

// Decides whether a given viewer should see the email watermark. Resolution
// order, most-specific-wins with EXEMPTION on top:
//   1. exempt email or exempt domain  -> never watermark (trusted viewer)
//   2. explicit per-share override     -> use it (record.watermark true/false)
//   3. explicit per-video override     -> use it (settings.watermarkByVideo)
//   4. global default                  -> settings.watermarkDefault
// Exemption deliberately wins over everything below it: an exempt viewer
// (e.g. an internal admin) is never watermarked, even on a share/video marked
// to watermark. Flip this order here if the opposite policy is ever wanted.
export function resolveWatermark({ settings, recipientEmail, shareWatermark, videoWatermark }) {
  const email = normalizeEmail(recipientEmail);
  const domain = email.split("@")[1] || "";
  if (settings.watermarkExemptEmails.includes(email)) return false;
  if (domain && settings.watermarkExemptDomains.includes(domain)) return false;
  if (typeof shareWatermark === "boolean") return shareWatermark;
  if (typeof videoWatermark === "boolean") return videoWatermark;
  return !!settings.watermarkDefault;
}
