import crypto from "crypto";
import { kvGet, kvSetEx, kvSadd, kvSrem, kvSmembers } from "./kv";
import { normalizeEmail } from "./gate";

// Append-only audit log of grant exchanges — every moment someone actually
// passed the email gate and received a viewing cookie, on either entrance
// (a /watch page or a /bundle page).
//
// Purpose is incident forensics: after a leak or a complaint you can answer
// "who exchanged a grant for this share, when, and from where" without
// reconstructing it from view counters, which only tell you totals.
//
// Four design decisions worth knowing, each a deliberate deviation from or
// tightening of the original sketch in the gate campaign's hardening menu:
//
// 1. THE EMAIL IS HASHED, never stored in clear. The share record already
//    holds the address, so the identity is one lookup away; storing it again
//    here would make this a second place PII accumulates, with a different
//    retention rule. The hash still supports the questions a log is for —
//    "was this the intended recipient?" (compare against the record) and
//    "did the same person exchange on several shares?" (compare hashes).
// 2. THE KEY CARRIES A RANDOM SUFFIX, not just a timestamp. Two exchanges
//    in the same millisecond would otherwise collide, and a colliding write
//    silently destroys an audit entry — the one thing a log must never do.
// 3. ENTRIES EXPIRE (90 days). "Append-only forever" in a KV store with no
//    retention story is an operational trap: unbounded growth, and an
//    ever-growing pile of IP addresses. A rolling window is honest about
//    what this is for. Raise LOG_TTL_SECONDS if your retention policy says
//    otherwise; nothing else depends on the value.
// 4. WRITES ARE BEST-EFFORT and never throw. An audit log that can break a
//    legitimate recipient's sign-in is worse than a gap in the log. The gap
//    is visible (the exchange happened, the entry is missing); a failed
//    exchange is a support ticket.
//
// The timestamp is zero-padded to a fixed width so lexicographic order over
// the index IS chronological order, which is what lets the reader below
// return newest-first without fetching everything.
export const GATE_LOG_INDEX_KEY = "gatelog-index";
const LOG_TTL_SECONDS = 90 * 24 * 3600;
const TS_WIDTH = 13; // ms epoch stays 13 digits until the year 2286

export function emailFingerprint(email) {
  return crypto.createHash("sha256").update(normalizeEmail(email)).digest("hex").slice(0, 16);
}

function logKey(at) {
  const stamp = String(at).padStart(TS_WIDTH, "0");
  return `gatelog:${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

export async function recordGrantExchange({ kind, token, email, ip, at = Date.now() }) {
  const key = logKey(at);
  const entry = {
    at,
    kind, // "watch" | "bundle"
    token, // the share token, or bundle:<id>
    emailHash: emailFingerprint(email),
    ip: ip || null,
  };
  try {
    await kvSetEx(key, entry, LOG_TTL_SECONDS);
    await kvSadd(GATE_LOG_INDEX_KEY, key);
  } catch (err) {
    // See decision 4 above: never let this break an exchange.
    console.error("gate audit log write failed (non-fatal):", err);
  }
  return key;
}

// Newest-first page of exchanges. Reads only the `limit` most recent index
// members rather than the whole index, which is what decision 3's fixed-width
// timestamp buys. Entries whose key has expired are dropped from the index as
// they're encountered (the same self-healing pages/api/cleanup.js does for
// share and bundle indexes).
export async function readRecentExchanges(limit = 100) {
  const keys = await kvSmembers(GATE_LOG_INDEX_KEY);
  const newestFirst = [...keys].sort().reverse();
  const window = newestFirst.slice(0, Math.min(Math.max(Number(limit) || 100, 1), 1000));

  const entries = await Promise.all(window.map((k) => kvGet(k)));
  const orphans = window.filter((_, i) => !entries[i]);
  if (orphans.length > 0) {
    await Promise.all(orphans.map((k) => kvSrem(GATE_LOG_INDEX_KEY, k).catch(() => {})));
  }

  return entries.filter(Boolean);
}
