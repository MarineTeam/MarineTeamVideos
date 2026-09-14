// Route-level test harness.
//
// Stands up an in-memory replacement for the two network services every API
// route talks to — the Upstash Redis REST API and the Resend HTTP API — by
// intercepting `globalThis.fetch`. Both happen to be plain fetch clients
// (lib/kv.js builds the URLs itself; the Resend SDK uses global fetch), so a
// single router covers the whole surface with zero new dependencies and no
// module mocking.
//
// This is the rung that validation-and-qa §4 called for: the unit suite
// proves helpers, this proves the ROUTES that call them — the gap the
// 2026-09-13 batch shipped with.
//
// Usage: call installHarness() BEFORE dynamically importing anything that
// reaches lib/kv.js, because lib/kv.js reads KV_REST_API_URL at module load.

export function setEnv(extra = {}) {
  Object.assign(process.env, {
    KV_REST_API_URL: "https://kv.test",
    KV_REST_API_TOKEN: "kv-token",
    GATE_SECRET: "route-test-secret",
    SITE_URL: "https://videos.test",
    RESEND_API_KEY: "re_test",
    RESEND_FROM: "sender@videos.test",
    ADMIN_USER: "admin",
    ADMIN_PASS: "hunter2",
    BUNNY_LIBRARY_ID: "1",
    BUNNY_TOKEN_KEY: "embedkey",
    ...extra,
  });
}

export function installHarness() {
  const store = new Map(); // key -> JSON string
  const sets = new Map(); // key -> Set of members
  const zsets = new Map(); // key -> Map of member -> score
  const ttls = new Map(); // key -> seconds
  const mail = []; // every message the app tried to send
  const ops = []; // every KV operation, so tests can assert read COUNTS
  let failMail = false;
  let kvDown = false;

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));

    // ---- Resend HTTP API ----
    if (u.hostname === "api.resend.com") {
      if (failMail) {
        return jsonResponse({ statusCode: 422, message: "mock send failure", name: "validation_error" }, 422);
      }
      mail.push(JSON.parse(opts.body));
      return jsonResponse({ id: `msg_${mail.length}` });
    }

    // ---- Upstash Redis REST API ----
    if (kvDown) throw new Error("KV unreachable (simulated)");

    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const [op, key, value] = parts;
    ops.push({ op, key });
    let result = null;

    switch (op) {
      case "set":
        store.set(key, value);
        if (u.searchParams.has("EX")) ttls.set(key, Number(u.searchParams.get("EX")));
        result = "OK";
        break;
      case "get":
        result = store.has(key) ? store.get(key) : null;
        break;
      case "del":
        store.delete(key);
        sets.delete(key);
        result = 1;
        break;
      case "keys": {
        const rx = new RegExp("^" + key.split("*").map(escapeRx).join(".*") + "$");
        result = [...store.keys()].filter((k) => rx.test(k));
        break;
      }
      case "sadd":
        if (!sets.has(key)) sets.set(key, new Set());
        sets.get(key).add(value);
        result = 1;
        break;
      case "srem":
        if (sets.has(key)) sets.get(key).delete(value);
        result = 1;
        break;
      case "smembers":
        result = sets.has(key) ? [...sets.get(key)] : [];
        break;
      // Sorted sets. NOTE: this encodes the SAME assumption about Upstash's
      // REST path shape that lib/kv.js does, so these tests prove the app's
      // logic, NOT that the real service accepts these commands. See roadmap
      // item (m)'s "known risk to check on deploy".
      case "zadd": {
        if (!zsets.has(key)) zsets.set(key, new Map());
        // parts = [op, key, score, member]
        zsets.get(key).set(parts[3], Number(parts[2]));
        result = 1;
        break;
      }
      case "zrem":
        if (zsets.has(key)) zsets.get(key).delete(value);
        result = 1;
        break;
      case "zcard":
        result = zsets.has(key) ? zsets.get(key).size : 0;
        break;
      case "zrange": {
        const entries = [...(zsets.get(key) || new Map()).entries()].sort(
          (a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)
        );
        const rev = parts.includes("REV");
        const ordered = rev ? entries.reverse() : entries;
        const start = Number(parts[2]);
        const stop = Number(parts[3]);
        result = ordered.slice(start, stop < 0 ? undefined : stop + 1).map(([m]) => m);
        break;
      }
      default:
        throw new Error(`harness: unhandled KV op "${op}"`);
    }

    return jsonResponse({ result });
  };

  return {
    store,
    sets,
    ttls,
    mail,
    ttlFor: (key) => ttls.get(key),
    record: (token) => {
      const raw = store.get(`bunnyshare:${token}`);
      return raw ? JSON.parse(raw) : null;
    },
    putRecord: (token, rec) => store.set(`bunnyshare:${token}`, JSON.stringify(rec)),
    indexed: () => [...(sets.get("bunnyshare-index") || [])],
    zsets,
    ordered: () => [...(zsets.get("bunnyshare-by-created") || new Map()).keys()],
    ops,
    countOps: (op) => ops.filter((o) => o.op === op).length,
    clearOps: () => ops.splice(0, ops.length),
    lastMail: () => mail[mail.length - 1],
    clearMail: () => mail.splice(0, mail.length),
    setMailFailing: (v) => {
      failMail = v;
    },
    setKvDown: (v) => {
      kvDown = v;
    },
    reset: () => {
      store.clear();
      sets.clear();
      zsets.clear();
      ttls.clear();
      mail.length = 0;
      ops.length = 0;
      failMail = false;
      kvDown = false;
    },
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function escapeRx(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jsonResponse(body, status = 200) {
  return {
    ok: status < 400,
    status,
    headers: new Map(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// ---- Next.js API req/res doubles -------------------------------------------

export function mockReq({ method = "POST", body = {}, query = {}, headers = {} } = {}) {
  return {
    method,
    body,
    query,
    headers: { "x-forwarded-for": "198.51.100.1", ...headers },
  };
}

export function mockRes() {
  const res = {
    statusCode: null,
    body: undefined,
    headers: {},
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
    send(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end() {
      this.headersSent = true;
      return this;
    },
  };
  return res;
}

// Calls a route's default-exported handler and returns the response double.
export async function call(handler, reqInit) {
  const req = mockReq(reqInit);
  const res = mockRes();
  await handler(req, res);
  return res;
}

// A response's full observable shape, for byte-comparing anti-enumeration
// branches: status + body + any headers the handler set.
export function fingerprint(res) {
  return JSON.stringify({ status: res.statusCode, body: res.body, headers: res.headers });
}
