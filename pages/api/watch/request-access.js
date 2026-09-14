import { kvGet, kvSetEx } from "../../../lib/kv";
import { normalizeEmail } from "../../../lib/gate";
import { sendAccessRequestEmail, adminNotifyAddress } from "../../../lib/mailer";
import { withApiMonitor } from "../../../lib/withMonitor";
import { allowRequestFromIp } from "../../../lib/rateLimit";

// PUBLIC endpoint (under /api/watch/*, so excluded from admin Basic Auth by
// the middleware matcher — see non-negotiable 7).
//
// Closes the dead end at the bottom of an expired link: a recipient whose
// link lapsed can ask the admin for more time instead of having to find
// them out-of-band. The admin then uses the existing Extend action, which
// keeps the recipient's original link/token working.
//
// Three deliberate constraints, because this is an unauthenticated endpoint
// that causes an email to be sent:
//
//  1. It carries NO free-text message from the requester (see
//     sendAccessRequestEmail) — nothing here is a channel for pushing
//     attacker-chosen prose into the admin's inbox.
//  2. It only sends when the typed address matches the record's own
//     recipient, so it can't be used to mail the admin about arbitrary
//     tokens, and never for a revoked share — revocation is a deliberate
//     cutoff, not something to invite an appeal against.
//  3. It answers with the SAME uniform 200 in every case, matching
//     /api/watch/request-link (invariant 4). Whether a token exists, has
//     expired rather than been revoked, or belongs to the typed address is
//     exactly as unknowable here as it is there.
const THROTTLE_SECONDS = 60 * 60; // one request per share per hour

async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const genericOk = () =>
    res.status(200).json({
      ok: true,
      message: "If that email matches this link, we've let the owner know.",
    });

  try {
    const { token, email } = req.body || {};
    if (!token || !email) {
      return res.status(400).json({ error: "token and email are required" });
    }

    if (!(await allowRequestFromIp(req))) {
      return genericOk();
    }

    const record = await kvGet(`bunnyshare:${token}`);
    // Only an expired-but-not-revoked share can be appealed. Everything else
    // — missing, revoked, or still live — takes the same silent path.
    if (!record || record.revoked || Date.now() <= record.expiresAt) {
      return genericOk();
    }

    const storedRecipients = String(record.email || "")
      .split(/[,;\s]+/)
      .map(normalizeEmail)
      .filter(Boolean);
    const typed = normalizeEmail(email);
    if (!storedRecipients.includes(typed)) {
      return genericOk();
    }

    const throttleKey = `accessreq:${token}`;
    if (await kvGet(throttleKey)) {
      return genericOk();
    }
    await kvSetEx(throttleKey, 1, THROTTLE_SECONDS);

    const notifyTo = adminNotifyAddress();
    if (notifyTo) {
      await sendAccessRequestEmail({
        to: notifyTo,
        videoTitle: record.videoTitle,
        recipientEmail: typed,
        token,
        expiredAt: record.expiresAt,
      });
    }

    return genericOk();
  } catch (err) {
    // Same reasoning as /api/watch/request-link's catch block: an error only
    // reachable on the path where the address actually matched must not
    // become a distinguishable response.
    console.error("watch/request-access error:", err);
    return genericOk();
  }
}

export default withApiMonitor(handler);
