import { kvGet, kvSetEx } from "../../../lib/kv";
import { signGrant, normalizeEmail } from "../../../lib/gate";
import { sendBundleMagicLinkEmail } from "../../../lib/mailer";
import { baseUrl } from "../../../lib/shares";
import { withApiMonitor } from "../../../lib/withMonitor";

// Same TTL/throttle constants and same uniform-response reasoning as
// /api/watch/request-link.js — see that file for why. This is the bundle
// listing page's equivalent public endpoint (excluded from Basic Auth in
// middleware.js).
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const THROTTLE_SECONDS = 30;

async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const genericOk = () =>
    res.status(200).json({
      ok: true,
      message: "If that email matches this link, we've sent a sign-in link to it.",
    });

  try {
    const { bundleId, email } = req.body || {};
    if (!bundleId || !email) {
      return res.status(400).json({ error: "bundleId and email are required" });
    }

    const bundle = await kvGet(`bunnybundle:${bundleId}`);
    if (!bundle || Date.now() > bundle.expiresAt) {
      // Don't distinguish invalid bundles from non-matching emails.
      return genericOk();
    }

    const typed = normalizeEmail(email);
    if (normalizeEmail(bundle.email) !== typed) {
      return genericOk();
    }

    const throttleKey = `bundlethrottle:${bundleId}`;
    const recentlySent = await kvGet(throttleKey);
    if (recentlySent) {
      return genericOk();
    }
    await kvSetEx(throttleKey, 1, THROTTLE_SECONDS);

    // Grant is bound to a "bundle:<id>" pseudo-token, distinct from any real
    // video token, so it can never be presented on a /watch/<token> page.
    const grant = signGrant({
      token: `bundle:${bundleId}`,
      email: typed,
      expiresAt: Date.now() + MAGIC_LINK_TTL_MS,
    });
    const link = `${baseUrl(req)}/bundle/${bundleId}?grant=${encodeURIComponent(grant)}`;

    await sendBundleMagicLinkEmail({ to: typed, link });

    return genericOk();
  } catch (err) {
    // Same reasoning as pages/api/watch/request-link.js: never let an
    // unexpected error become a response distinguishable from genericOk() —
    // it only fires on the path where the email actually matched, so a
    // 500-vs-200 split would let an attacker fingerprint valid bundle+email
    // pairs by status code alone.
    console.error("bundle/request-link error:", err);
    return genericOk();
  }
}

export default withApiMonitor(handler);
