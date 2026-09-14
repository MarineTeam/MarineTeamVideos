import { kvGet, kvSetEx } from "./kv";

// Per-IP rate limiting for the two PUBLIC magic-link endpoints
// (/api/watch/request-link, /api/bundle/request-link).
//
// The pre-existing throttle on those endpoints is per-share-token only
// (`gatethrottle:<token>`, 30s), which stops one recipient being
// email-bombed on one link but does nothing about a single source spraying
// many different tokens — for inbox spam across a set of harvested links,
// or simply to hammer KV. This adds the missing dimension.
//
// Deliberately a coarse fixed window (a counter with a 60s TTL) rather than
// a sliding log: it costs one GET plus at most one SET, needs no new data
// structure, and self-expires. The read-modify-write is not atomic, so
// concurrent requests can undercount — accepted, because this is a spam
// dampener, not a security boundary. The email gate is what actually
// protects a share.
//
// Fails OPEN on a missing IP or a KV error: a rate limiter that locks
// legitimate recipients out when KV blips is worse than the abuse it
// prevents.
const IP_PREFIX = "gateip:";
const WINDOW_SECONDS = 60;
const DEFAULT_LIMIT = 10;

// Vercel sets x-forwarded-for; the client-controlled portion is appended, so
// the FIRST entry is the one the edge observed. x-real-ip is the fallback
// for other hosts. Neither is trustworthy in a hostile sense — spoofing it
// only buys an attacker a fresh bucket, which is why this is a dampener.
export function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  const real = req.headers["x-real-ip"];
  if (real) return String(real).trim();
  return "";
}

// Records one request from `ip` and reports whether it is within the limit.
// Returns true when the caller should proceed.
export async function allowRequestFromIp(req, limit = DEFAULT_LIMIT) {
  const ip = clientIp(req);
  if (!ip) return true; // no usable IP (local dev, unknown host) — fail open

  const key = `${IP_PREFIX}${ip}`;
  try {
    const current = Number(await kvGet(key)) || 0;
    if (current >= limit) return false;
    // TTL restarts on each write, so a sustained sender stays capped; a
    // bursty one gets a fresh window 60s after their last request.
    await kvSetEx(key, current + 1, WINDOW_SECONDS);
    return true;
  } catch (err) {
    console.error("per-IP rate limit check failed (allowing):", err);
    return true;
  }
}
