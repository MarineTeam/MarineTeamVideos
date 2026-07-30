// Thin wrapper around the Upstash Redis REST API.
// Works with Vercel's "Upstash for Redis" marketplace storage,
// or a standalone free Upstash database — both expose the same
// KV_REST_API_URL / KV_REST_API_TOKEN env vars.

import { recordQuery } from "./monitor";

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// This is the single I/O chokepoint for every KV read/write in the app, which
// makes it the one place that needs to instrument the query monitor — every
// caller (lib/shares.js, lib/bundles.js, lib/settings.js, every API route)
// gets timing/counting for free with no per-caller changes.
async function kvFetch(path) {
  // Date.now(), not process.hrtime — this file is imported by middleware.js,
  // which runs in the Edge Runtime and doesn't have process.hrtime.
  const start = Date.now();
  let ok = true;
  try {
    const res = await fetch(`${KV_URL}${path}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!res.ok) {
      ok = false;
      throw new Error(`KV error ${res.status}: ${await res.text()}`);
    }
    return await res.json();
  } finally {
    const ms = Date.now() - start;
    const [, op, encodedKey] = path.split("/");
    const key = encodedKey ? decodeURIComponent(encodedKey) : "";
    recordQuery(`${ok ? "" : "ERR "}${op}`.trim(), key, ms);
  }
}

export async function kvSet(key, value) {
  const encoded = encodeURIComponent(JSON.stringify(value));
  return kvFetch(`/set/${encodeURIComponent(key)}/${encoded}`);
}

// Like kvSet, but the key auto-expires after `seconds` (Upstash EX option).
// Handy for short-lived throttles that shouldn't accumulate.
export async function kvSetEx(key, value, seconds) {
  const encoded = encodeURIComponent(JSON.stringify(value));
  return kvFetch(`/set/${encodeURIComponent(key)}/${encoded}?EX=${Number(seconds)}`);
}

export async function kvGet(key) {
  const r = await kvFetch(`/get/${encodeURIComponent(key)}`);
  return r.result ? JSON.parse(r.result) : null;
}

export async function kvDel(key) {
  return kvFetch(`/del/${encodeURIComponent(key)}`);
}

export async function kvKeys(pattern) {
  const r = await kvFetch(`/keys/${encodeURIComponent(pattern)}`);
  return r.result || [];
}

// Set operations, used to maintain index sets (e.g. bunnyshare-index) as an
// O(1)-membership alternative to scanning the whole keyspace with kvKeys.
export async function kvSadd(key, member) {
  return kvFetch(`/sadd/${encodeURIComponent(key)}/${encodeURIComponent(member)}`);
}

export async function kvSrem(key, member) {
  return kvFetch(`/srem/${encodeURIComponent(key)}/${encodeURIComponent(member)}`);
}

export async function kvSmembers(key) {
  const r = await kvFetch(`/smembers/${encodeURIComponent(key)}`);
  return r.result || [];
}
