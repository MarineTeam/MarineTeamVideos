import crypto from "crypto";
import { kvGet, kvSet, kvSadd } from "./kv";

// A Redis SET of every live share token, maintained alongside the
// `bunnyshare:<token>` records themselves so callers can list/count shares
// via SMEMBERS instead of a full-keyspace KEYS scan (which gets slower as
// the whole KV store grows, not just this app's share count). See
// pages/api/backfill-index.js for populating this from records that
// existed before the index did.
export const SHARE_INDEX_KEY = "bunnyshare-index";

// Public base URL used when building every emailed link (share, magic-link,
// bundle). REQUIRES SITE_URL — fails loudly rather than falling back to the
// request's Host header, same fail-loud pattern as GATE_SECRET (lib/gate.js).
// The old fallback (`https://${req.headers.host}`) trusted a client-supplied
// header to build outbound email links: a forged Host let an attacker make
// the app email real recipients a legitimate-looking notification pointing
// at an attacker's domain (CodeQL: host header poisoning in email
// generation). escapeHtml/isValidUrl (lib/mailer.js) never covered this —
// they validate the URL is well-formed HTML-safe http(s), not that the host
// is actually this app.
export function baseUrl(req) {
  const site = process.env.SITE_URL;
  if (!site) {
    throw new Error(
      "SITE_URL is not set. Add your app's public base URL (e.g. https://your-app.example.com) to the environment — required so email links can't be built from a spoofable request Host header."
    );
  }
  return site;
}

// Parses one-or-many recipient emails from a string or array, splitting on
// commas/semicolons/whitespace INSIDE each element too. This is the single
// place that turns user input into a recipient list — a comma-joined string
// must never survive into a share record's `email` field (records stored
// with combined strings can never pass the email gate).
export function parseEmails(input) {
  const list = (Array.isArray(input) ? input : [input]).flatMap((e) =>
    String(e || "").split(/[,;\s]+/)
  );
  return [...new Set(list.map((e) => e.trim()).filter((e) => e.includes("@")))];
}

// Creates a single share record with its own unguessable token and stores it.
// Returns the stored record plus the recipient-facing /watch link. Each call
// generates a fresh random token, so N calls always produce N distinct links.
export async function createShareRecord({ videoId, videoTitle, email, hours, siteUrl, watermark, source }) {
  const token = crypto.randomBytes(16).toString("hex");
  const expiresAt = Date.now() + (Number(hours) || 72) * 3600 * 1000;

  const record = {
    token,
    videoId,
    videoTitle: videoTitle || videoId,
    email,
    createdAt: Date.now(),
    expiresAt,
    revoked: false,
    // Per-share watermark override. Additive and stored ONLY when explicitly
    // true/false — absent means "inherit the global default" (see
    // lib/settings.js resolveWatermark). Records made before this existed have
    // no field and inherit, exactly as they did before.
    ...(typeof watermark === "boolean" ? { watermark } : {}),
    // How this record was created: "invite" for the persistent per-video
    // Private list (lib/invites.js), absent for a normal Share/Bulk Share
    // call. Additive — absent on records made before this existed, which the
    // admin table reads as "Share" (see pages/index.js). There is no
    // "bulk" value: Bulk Share is still just a normal share from the
    // recipient's/record's point of view, one record per video either way.
    ...(source === "invite" ? { source } : {}),
  };

  await kvSet(`bunnyshare:${token}`, record);

  // Best-effort: never let an index-write hiccup block share creation, which
  // has already succeeded by this point (the record is live and the link
  // will work regardless). Worst case of a failed SADD here is the share
  // temporarily missing from the admin listing until the next backfill run
  // — never a broken or missing link, which is the one thing that must
  // never happen (see architecture-contract's never-break-live-links rule).
  try {
    await kvSadd(SHARE_INDEX_KEY, token);
  } catch (err) {
    console.error("Failed to index new share token (non-fatal):", err);
  }

  const link = `${siteUrl}/watch/${token}`;
  return { record, link };
}

// Marks (or clears) the emailFailed flag on an existing record, so a share
// whose notification email failed to send isn't a silent ghost in the admin
// table — the link exists either way, but the admin can see and retry it.
// Additive field: absent on records created before this existed.
export async function setEmailFailed(token, failed, errorMessage) {
  const record = await kvGet(`bunnyshare:${token}`);
  if (!record) return null;
  record.emailFailed = failed || undefined;
  record.emailError = failed ? errorMessage : undefined;
  await kvSet(`bunnyshare:${token}`, record);
  return record;
}
