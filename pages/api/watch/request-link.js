import { kvGet, kvSetEx } from "../../../lib/kv";
import { signGrant, normalizeEmail } from "../../../lib/gate";
import { sendMagicLinkEmail } from "../../../lib/mailer";
import { baseUrl } from "../../../lib/shares";
import { withApiMonitor } from "../../../lib/withMonitor";

// How long the emailed magic link stays valid before the recipient must
// request a fresh one.
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
// Minimum gap between magic-link emails for the same share, to prevent abuse.
const THROTTLE_SECONDS = 30;

// Public endpoint (excluded from admin Basic Auth in middleware.js).
// Given a share token and a typed email, emails a magic link ONLY if the email
// matches the recipient the share was created for. The response is intentionally
// identical whether or not the email matched, so the page can't be used to probe
// which address a link belongs to.
async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const genericOk = () =>
    res.status(200).json({
      ok: true,
      message: "If that email matches this link, we've sent a sign-in link to it.",
    });

  try {
    const { token, email } = req.body || {};
    if (!token || !email) {
      return res.status(400).json({ error: "token and email are required" });
    }

    const record = await kvGet(`bunnyshare:${token}`);
    if (!record || record.revoked || Date.now() > record.expiresAt) {
      // Don't distinguish invalid links from non-matching emails.
      return genericOk();
    }

    // Match the typed address against the record's email. Records are written
    // with exactly one address per record, but records created by older code
    // could store a comma/space-joined string of several addresses — split
    // and match any of them, so those legacy records still gate correctly.
    // The magic link goes to the TYPED (matched) address only.
    const storedRecipients = String(record.email || "")
      .split(/[,;\s]+/)
      .map(normalizeEmail)
      .filter(Boolean);
    const typed = normalizeEmail(email);
    if (!storedRecipients.includes(typed)) {
      return genericOk();
    }

    // Best-effort throttle so a matching recipient can't be email-bombed.
    const throttleKey = `gatethrottle:${token}`;
    const recentlySent = await kvGet(throttleKey);
    if (recentlySent) {
      return genericOk();
    }
    await kvSetEx(throttleKey, 1, THROTTLE_SECONDS);

    const grant = signGrant({
      token,
      email: typed,
      expiresAt: Date.now() + MAGIC_LINK_TTL_MS,
    });
    const link = `${baseUrl(req)}/watch/${token}?grant=${encodeURIComponent(grant)}`;

    // Send to the matched typed address, never record.email verbatim — a
    // legacy combined-string record would otherwise email every address in
    // the string at once.
    await sendMagicLinkEmail({ to: typed, videoTitle: record.videoTitle, link });

    return genericOk();
  } catch (err) {
    // Never let an unexpected error (e.g. a misconfigured GATE_SECRET or
    // SITE_URL) become a response distinguishable from genericOk() — that
    // error only fires on the code path where the email actually matched,
    // so a 500-vs-200 split here would let an attacker fingerprint valid
    // token+email pairs by status code alone. Log server-side; tell the
    // caller nothing more than every other outcome does.
    console.error("watch/request-link error:", err);
    return genericOk();
  }
}

export default withApiMonitor(handler);
