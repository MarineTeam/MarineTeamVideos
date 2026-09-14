import { NextResponse } from "next/server";
import { kvGet } from "./lib/kv";
import { adminGeoWhitelist, adminGeoBypassEmails, isGeoAllowedEdge } from "./lib/geo";
import { timingSafeEqualStr } from "./lib/safeCompare";

// Protects the admin page and its API routes with HTTP Basic Auth.
// The /watch/[token] and /bundle/[bundleId] pages are NOT covered, so
// recipients can open their links freely — and neither are /api/watch/* or
// /api/bundle/*, the public endpoints recipients call to request their
// email-gated sign-in links.
export async function middleware(req) {
  const auth = req.headers.get("authorization");
  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASS;

  // No configured credentials means NOBODY gets in — same end state as the
  // previous plain `===` compare against an undefined env var, but stated
  // explicitly so the constant-time compare below can never be handed a
  // stringified `undefined` to match against.
  if (auth && user && pass) {
    const [, encoded] = auth.split(" ");
    const decoded = Buffer.from(encoded, "base64").toString();
    const idx = decoded.indexOf(":");
    const u = decoded.slice(0, idx);
    const p = decoded.slice(idx + 1);
    // Constant-time compare (lib/safeCompare.js). Both halves are ALWAYS
    // evaluated — no `&&` short-circuit — so a correct username followed by
    // a wrong password costs exactly as much as a wrong username. The
    // previous `u === user && p === pass` leaked, by timing, both how much
    // of each credential matched and whether the username was right at all.
    const [userOk, passOk] = await Promise.all([
      timingSafeEqualStr(u, user),
      timingSafeEqualStr(p, pass),
    ]);
    if (userOk && passOk) {
      // Additional, OPT-IN geo restriction on top of valid credentials.
      // The country list comes only from ADMIN_GEO_WHITELIST (an env var,
      // never the admin-editable KV settings — see lib/geo.js for why);
      // when it's unset this whole block is a no-op with zero extra KV
      // calls, so a deployment that never sets it behaves exactly as
      // before. When it IS set, enforcement is still gated by a runtime
      // toggle (settings.adminGeoWhitelistEnabled) so an admin can flip it
      // off in the Settings panel without a redeploy — but the ultimate
      // recovery path if it ever locks someone out is unsetting the env
      // var in the hosting dashboard, a surface this check can't reach.
      // A username listed in ADMIN_GEO_BYPASS_EMAILS short-circuits straight
      // past the country/toggle check below — no KV call, regardless of
      // country or whether enforcement is even on. It's a standing safety
      // net meant to be armed before traveling, not an in-the-moment fix
      // (env var changes need a redeploy).
      const whitelist = adminGeoWhitelist();
      if (whitelist.length > 0 && !adminGeoBypassEmails().includes(u.toLowerCase())) {
        const settings = await kvGet("bunnysettings:global");
        if (settings && settings.adminGeoWhitelistEnabled && !isGeoAllowedEdge(req, whitelist)) {
          return new NextResponse("Admin access is restricted from your region", { status: 403 });
        }
      }
      return NextResponse.next();
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Admin"' },
  });
}

export const config = {
  // Everything under /api EXCEPT /api/watch/* and /api/bundle/* (recipient-facing, must stay public).
  matcher: ["/", "/api/((?!watch/|bundle/).*)"],
};
