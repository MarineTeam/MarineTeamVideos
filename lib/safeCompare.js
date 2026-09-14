// Constant-time string comparison that works in BOTH the Edge Runtime and
// Node — middleware.js runs on the Edge, where `node:crypto`'s
// `timingSafeEqual` is not available, so this uses WebCrypto
// (`globalThis.crypto.subtle`), which both runtimes provide.
//
// Technique: "double HMAC". Each input is HMAC'd under a random key that
// exists only for this one call, and the two fixed-length (32-byte) digests
// are compared with a branch-free XOR accumulation. Two properties matter:
//
//  1. The digests are always the same length regardless of input length, so
//     the comparison loop itself can't leak how long the secret is.
//  2. An attacker can't predict or precompute the digests, because the HMAC
//     key is random per call — so even a non-constant-time comparison of the
//     digests would reveal nothing about the plaintext.
//
// This replaces a plain `===` on ADMIN_USER/ADMIN_PASS in middleware.js,
// which short-circuits on the first differing byte and so leaks, through
// response timing, how much of a guessed credential was correct.
export async function timingSafeEqualStr(a, b) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  const encoder = new TextEncoder();

  // Fall back to a non-short-circuiting comparison if WebCrypto is somehow
  // unavailable. Still far better than `===`, and never throws — an auth
  // check must not become a 500.
  if (!subtle) return slowEqualStr(a, b);

  const keyBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const key = await subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const [digestA, digestB] = await Promise.all([
    subtle.sign("HMAC", key, encoder.encode(String(a))),
    subtle.sign("HMAC", key, encoder.encode(String(b))),
  ]);

  const viewA = new Uint8Array(digestA);
  const viewB = new Uint8Array(digestB);
  let diff = viewA.length ^ viewB.length;
  for (let i = 0; i < viewA.length; i++) diff |= viewA[i] ^ viewB[i];
  return diff === 0;
}

// Length-independent-ish fallback: always walks the full longer string
// instead of stopping at the first mismatch.
function slowEqualStr(a, b) {
  const sa = String(a);
  const sb = String(b);
  let diff = sa.length ^ sb.length;
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    diff |= (sa.charCodeAt(i) || 0) ^ (sb.charCodeAt(i) || 0);
  }
  return diff === 0;
}
