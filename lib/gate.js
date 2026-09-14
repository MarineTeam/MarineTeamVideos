import crypto from "crypto";

// Stateless, signed "grant" tokens used to email-gate /watch/<token>.
//
// A grant proves that the holder demonstrated control of the recipient email
// on a specific share. We sign a small JSON payload with HMAC-SHA256 so it can
// be verified without any extra storage:
//   - a short-lived grant is emailed as the magic link (?grant=...)
//   - clicking it exchanges the magic-link grant for a longer-lived cookie
//     grant, scoped (by cookie Path) to that one /watch/<token>.
//
// Requires GATE_SECRET. We fail loudly rather than fall back to an insecure
// default, so a misconfigured deploy can't hand out forgeable grants.
function secret() {
  const s = process.env.GATE_SECRET;
  if (!s) {
    throw new Error(
      "GATE_SECRET is not set. Add a long random value to your environment to enable email-gated links."
    );
  }
  return s;
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(str) {
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// Signs a grant for a given share token + email that expires at `expiresAt` (ms).
export function signGrant({ token, email, expiresAt }) {
  const payload = { t: token, e: normalizeEmail(email), x: expiresAt };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", secret()).update(body).digest());
  return `${body}.${sig}`;
}

// Verifies a grant string and that it belongs to `token`. Returns the decoded
// payload ({ t, e, x }) if valid and unexpired, otherwise null. Never throws on
// malformed input.
export function verifyGrant(value, { token } = {}) {
  try {
    if (!value || typeof value !== "string") return null;
    const [body, sig] = value.split(".");
    if (!body || !sig) return null;

    const expected = crypto.createHmac("sha256", secret()).update(body).digest();
    const given = fromB64url(sig);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return null;
    }

    const payload = JSON.parse(fromB64url(body).toString("utf8"));
    if (typeof payload.x !== "number" || Date.now() > payload.x) return null;
    if (token && payload.t !== token) return null;
    return payload;
  } catch {
    return null;
  }
}

// Stable, non-reversible fingerprint of a grant string, used as the KV key
// that marks a magic-link grant as already spent (see the single-use
// exchange in pages/watch/[token].js and pages/bundle/[bundleId].js).
//
// Hashed rather than stored raw on purpose: the grant IS a credential, and
// a KV dump of live credentials would be worth more to an attacker than the
// replay protection is worth to us. The hash is enough to recognise a
// grant we've seen, and useless for minting one.
export function grantFingerprint(grant) {
  return crypto.createHash("sha256").update(String(grant)).digest("hex");
}

export { normalizeEmail };
