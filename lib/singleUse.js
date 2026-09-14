import { kvGet, kvSetEx } from "./kv";
import { grantFingerprint } from "./gate";

// Single-use enforcement for emailed magic-link grants.
//
// A grant is a stateless HMAC credential (lib/gate.js) — deliberately so,
// see the architecture contract. Statelessness means that within its 15
// minute life a grant verifies every time it is presented, so anyone who
// intercepts the emailed link (a shared mailbox, a forwarded message, a
// mail-server log) can replay it. This module is the ONE bounded exception
// to "no grant state in KV": a tiny marker per spent grant, nothing else.
//
// Deliberate design points:
//
//  * Only the COOKIE-SETTING exchange spends a grant. Any other path that
//    happens to see a `?grant=` (an invalid one, an expired one) leaves it
//    unspent. This is what keeps an email client's link prefetcher from
//    silently burning the link before the human clicks: a prefetch that
//    does not keep the Set-Cookie response is also a prefetch that has
//    already spent the grant, so we accept that narrow case rather than
//    spend grants on paths that grant nothing.
//  * The marker's TTL is the grant's own remaining life. After that the
//    grant fails `verifyGrant` on expiry anyway, so remembering it longer
//    would store garbage forever.
//  * Both functions are best-effort and never throw. A KV hiccup degrades
//    this to the previous replayable-within-TTL behaviour rather than
//    locking out a legitimate recipient holding a valid grant — for this
//    app, "never break live links" outranks replay protection.
const USED_PREFIX = "gateused:";

export async function isGrantSpent(grant) {
  try {
    return Boolean(await kvGet(`${USED_PREFIX}${grantFingerprint(grant)}`));
  } catch (err) {
    console.error("single-use grant check failed (allowing):", err);
    return false;
  }
}

export async function markGrantSpent(grant, expiresAtMs) {
  const ttl = Math.ceil((Number(expiresAtMs) - Date.now()) / 1000);
  if (!Number.isFinite(ttl) || ttl <= 0) return;
  try {
    await kvSetEx(`${USED_PREFIX}${grantFingerprint(grant)}`, 1, ttl);
  } catch (err) {
    console.error("single-use grant marking failed (non-fatal):", err);
  }
}
