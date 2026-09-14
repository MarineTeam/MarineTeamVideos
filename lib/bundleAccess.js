import { signGrant, verifyGrant } from "./gate";
import { buildGateCookie, EXPIRED_NOTICE } from "./watchAccess";

// The access decision for the bundle listing page — the sibling of
// lib/watchAccess.js, extracted for the same reason: it used to live inside
// a JSX file that plain Node cannot parse, which put the gate's second
// entrance beyond the reach of the test suite (roadmap item (r)).
//
// Same contract as watchAccess: this module DECIDES and performs no I/O.
// Everything is passed in, the two asynchronous dependencies arrive as
// injected callbacks (`isSpent` for single-use, `loadMembers` for the
// bundle's member records), and the result is data.
//
// The one structural difference from the per-video gate: a successful
// exchange mints MANY cookies — one for the listing page plus a standard
// per-video cookie for every live member. That is the entire value of a
// bundle (verify once, not N times), and it works by minting ordinary
// per-video cookies rather than by weakening what /watch accepts. Those
// per-video cookies are built by watchAccess's own `buildGateCookie`, so
// they are byte-identical to the ones the watch page mints by construction
// rather than by two implementations agreeing.
//
// Returns exactly one of:
//   { kind: "invalid",    reason }
//   { kind: "exchange",   spend, setCookies, redirectTo }
//   { kind: "need-email", notice? }
//   { kind: "authorized", items }

export function bundleCookieName(bundleId) {
  return `gate_bundle_${bundleId}`;
}

// A bundle grant is bound to a `bundle:<id>` pseudo-token, which can never
// collide with a real 32-hex video token — so a bundle grant can never
// verify on a /watch page, and vice versa, with no change to lib/gate.js.
export function bundleToken(bundleId) {
  return `bundle:${bundleId}`;
}

export function buildBundleCookie({ bundleId, grant, maxAgeSeconds, secure }) {
  return (
    `${bundleCookieName(bundleId)}=${encodeURIComponent(grant)}; HttpOnly; ` +
    `Path=/bundle/${bundleId}; SameSite=Lax; Max-Age=${maxAgeSeconds}` +
    (secure ? "; Secure" : "")
  );
}

const maxAge = (expiresAt, now) => Math.max(0, Math.floor((expiresAt - now) / 1000));

export async function decideBundleAccess({
  bundleId,
  bundle,
  grant,
  cookies = {},
  geoAllowed = true,
  secure = false,
  isSpent = async () => false,
  loadMembers = async () => [],
  now = Date.now(),
}) {
  if (!bundle) {
    return { kind: "invalid", reason: "Link not found." };
  }
  if (now > bundle.expiresAt) {
    return { kind: "invalid", reason: "This link has expired." };
  }
  if (!geoAllowed) {
    return { kind: "invalid", reason: "This page isn't available in your region." };
  }

  const token = bundleToken(bundleId);

  // 1. Fresh magic-link click: exchange for the listing cookie AND a
  //    per-video cookie for every live member.
  if (grant) {
    const payload = verifyGrant(grant, { token });
    const spent = payload ? await isSpent(grant) : false;
    if (payload && !spent) {
      const members = await loadMembers();
      const setCookies = [
        buildBundleCookie({
          bundleId,
          grant: signGrant({ token, email: bundle.email, expiresAt: bundle.expiresAt }),
          maxAgeSeconds: maxAge(bundle.expiresAt, now),
          secure,
        }),
      ];

      for (const { token: memberToken, record } of members) {
        // A member whose record is gone (cleanup, permanent delete) is
        // simply skipped — never a broken cookie, never an error.
        if (!record) continue;
        setCookies.push(
          buildGateCookie({
            token: memberToken,
            grant: signGrant({
              token: memberToken,
              email: record.email,
              expiresAt: record.expiresAt,
            }),
            maxAgeSeconds: maxAge(record.expiresAt, now),
            secure,
          })
        );
      }

      return {
        kind: "exchange",
        spend: { grant, expiresAt: payload.x },
        setCookies,
        redirectTo: `/bundle/${bundleId}`,
      };
    }
    return { kind: "need-email", notice: EXPIRED_NOTICE };
  }

  // 2. Returning viewer with a valid listing cookie. Every member's status
  //    is re-read LIVE from its own share record here — the bundle record
  //    never stores a title or a status, so this page can never show stale
  //    state (architecture-contract 2.6: no second source of truth).
  if (verifyGrant(cookies[bundleCookieName(bundleId)], { token })) {
    const members = await loadMembers();
    return {
      kind: "authorized",
      items: members
        .filter(({ record }) => record)
        .map(({ token: memberToken, record }) => ({
          token: memberToken,
          videoTitle: record.videoTitle,
          link: `/watch/${memberToken}`,
          status: record.revoked ? "revoked" : now > record.expiresAt ? "expired" : "active",
        })),
    };
  }

  // 3. No grant yet — ask for the email.
  return { kind: "need-email" };
}
