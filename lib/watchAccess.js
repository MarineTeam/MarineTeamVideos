import { signGrant, verifyGrant } from "./gate";
import { resolveWatermark, getVideoWatermark } from "./settings";

// The access decision for a recipient-facing watch page.
//
// This logic used to live inside getServerSideProps in
// pages/watch/[token].js. That file contains JSX, which plain Node cannot
// parse and this repo has no transform for, so the single most
// security-critical decision in the app — may this visitor watch, and does
// this magic link spend — was permanently unreachable from the test suite.
// Moving it here changes nothing about the behaviour and makes all of it
// testable (roadmap item (r)).
//
// The split is: this module DECIDES, the page performs EFFECTS. Every input
// is passed in and every output is data, so there is no I/O here at all.
// The one asynchronous dependency, "has this grant already been spent",
// arrives as an injected `isSpent` callback rather than a direct KV import,
// which is what keeps the whole decision testable without a store.
//
// Returns exactly one of:
//   { kind: "invalid",    reason, canRequestAccess? }
//   { kind: "exchange",   spend, setCookie, redirectTo }
//   { kind: "need-email", title, notice? }
//   { kind: "authorized", viewUpdate, trackAuth, watermarkText, resumeSec, durationSec, title, videoId }
export const EXPIRED_NOTICE = "That sign-in link has expired. Enter your email to get a new one.";
const TRACK_GRANT_MAX_MS = 6 * 3600 * 1000;

export function cookieName(token) {
  return `gate_${token}`;
}

// The exact Set-Cookie string the gate has always produced. Kept in one
// place so its shape is asserted by tests rather than by reading the page:
// the name, the Path scope, HttpOnly and SameSite are all compatibility
// surface (architecture-contract 5.3) and must not drift.
export function buildGateCookie({ token, grant, maxAgeSeconds, secure }) {
  return (
    `${cookieName(token)}=${encodeURIComponent(grant)}; HttpOnly; ` +
    `Path=/watch/${token}; SameSite=Lax; Max-Age=${maxAgeSeconds}` +
    (secure ? "; Secure" : "")
  );
}

export async function decideWatchAccess({
  token,
  record,
  settings,
  grant,
  cookies = {},
  geoAllowed = true,
  secure = false,
  isSpent = async () => false,
  now = Date.now(),
}) {
  if (!record) {
    return { kind: "invalid", reason: "Link not found." };
  }
  if (record.revoked) {
    return { kind: "invalid", reason: "Access to this video has been revoked." };
  }
  if (now > record.expiresAt) {
    // Only an EXPIRED link offers the "ask for more time" form. A revoked
    // one deliberately does not: revocation is an explicit decision by the
    // admin, and inviting the recipient to appeal it would undercut that. A
    // missing record can't offer it either — there is no recipient address
    // to verify an asker against.
    return { kind: "invalid", reason: "This link has expired.", canRequestAccess: true };
  }
  // Optional per-share view cap. Absent on every record created before this
  // feature, which therefore behaves exactly as before: unlimited views.
  if (record.maxViews && (record.viewCount || 0) >= record.maxViews) {
    return { kind: "invalid", reason: "This link has reached its view limit." };
  }
  if (!geoAllowed) {
    return { kind: "invalid", reason: "This video isn't available in your region." };
  }

  // 1. Fresh magic-link click: exchange the short-lived grant for a scoped,
  //    longer-lived cookie, then redirect to the clean URL so the one-time
  //    grant doesn't linger in the address bar or browser history.
  if (grant) {
    const payload = verifyGrant(grant, { token });
    // A magic link is single-use. An already-spent grant is treated EXACTLY
    // like an expired one — same fall-through, same notice — so a replay
    // reveals nothing about whether the grant was ever real.
    const spent = payload ? await isSpent(grant) : false;
    if (payload && !spent) {
      const cookieGrant = signGrant({ token, email: record.email, expiresAt: record.expiresAt });
      const maxAgeSeconds = Math.max(0, Math.floor((record.expiresAt - now) / 1000));
      return {
        kind: "exchange",
        // The caller spends it at the moment of the cookie-setting
        // exchange, never on any other path (see lib/singleUse.js).
        spend: { grant, expiresAt: payload.x },
        setCookie: buildGateCookie({ token, grant: cookieGrant, maxAgeSeconds, secure }),
        redirectTo: `/watch/${token}`,
      };
    }
    return { kind: "need-email", title: record.videoTitle, notice: EXPIRED_NOTICE };
  }

  // 2. Returning viewer with a valid cookie grant.
  if (verifyGrant(cookies[cookieName(token)], { token })) {
    return {
      kind: "authorized",
      videoId: record.videoId,
      title: record.videoTitle,
      // View tracking: additive fields only, so records created before this
      // feature keep working untouched. Counted per authorized render,
      // never for the email form. Last-writer-wins is fine at this scale.
      viewUpdate: {
        ...record,
        viewCount: (record.viewCount || 0) + 1,
        firstViewedAt: record.firstViewedAt || now,
        lastViewedAt: now,
      },
      // Short-lived tracking grant for the playback reporter: the gate
      // cookie is Path-scoped and HttpOnly, so client JS cannot present it
      // to /api/watch/track. Token-bound, capped at 6h or share expiry.
      trackAuth: signGrant({
        token,
        email: record.email,
        expiresAt: Math.min(record.expiresAt, now + TRACK_GRANT_MAX_MS),
      }),
      // The verified recipient email is what we stamp on the player.
      watermarkText: resolveWatermark({
        settings,
        recipientEmail: record.email,
        shareWatermark: record.watermark,
        videoWatermark: getVideoWatermark(settings, record.videoId),
      })
        ? record.email
        : null,
      // Resume support: additive fields, absent (→ 0) on older records.
      resumeSec: record.lastPositionSec || 0,
      durationSec: record.durationSec || 0,
    };
  }

  // 3. No grant yet — ask for the email.
  return { kind: "need-email", title: record.videoTitle };
}
