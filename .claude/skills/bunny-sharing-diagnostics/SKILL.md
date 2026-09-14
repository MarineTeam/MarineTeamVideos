---
name: bunny-sharing-diagnostics
description: >
  Executable measurement tools for the bunny-sharing app: the gate crypto
  self-test (9 cases), a KV share-record inspector, a live email-path probe,
  a Bunny Stream connectivity/signing probe, and a signed-URL verifier that
  reports MATCH/MISMATCH against local keys. Load this when you need to
  MEASURE something — verify gate.js after a change, see what's in Redis,
  prove which email path is active, or determine whether a 403 is a key
  problem vs expiry vs Bunny-side config. Do NOT load this to decide WHICH
  measurement to take for a symptom (bunny-sharing-debugging-playbook routes
  you here), for the full live gate certification protocol
  (bunny-sharing-email-gate-campaign), or for env-var setup
  (bunny-sharing-env-and-setup).
---

# bunny-sharing diagnostics

Measure, don't eyeball. Every script lives in this skill's `scripts/` directory,
runs from the repo root with plain Node (no extra dependencies), reads
credentials from the environment, and exits non-zero on failure. To load your
real env first:

```bash
set -a; . ./.env.local; set +a
```

Exit-code convention (all scripts): `0` pass, `1` measured failure, `2` missing
input/env (nothing was measured).

| Script | Measures | Needs credentials? |
| --- | --- | --- |
| `gate-selftest.mjs` | lib/gate.js crypto contract (9 cases) | No |
| `kv-inspect.mjs` | Actual share records + throttle keys in Upstash | KV_REST_API_URL/TOKEN |
| `email-probe.mjs` | One real send through the app's deliver() path | Resend or SMTP vars |
| `bunny-probe.mjs` | Bunny API reachability + embed/thumbnail signing | BUNNY_* vars |
| `sign-check.mjs` | Whether local keys reproduce a signed URL's token | The relevant key only |

## 1. gate-selftest.mjs — gate crypto contract

```bash
node .claude/skills/bunny-sharing-diagnostics/scripts/gate-selftest.mjs
```

Runs 9 assertions against `lib/gate.js`: valid grant verifies; email normalized
to lowercase in payload; wrong-token binding rejected; tampered signature
rejected; expired rejected; garbage and undefined rejected without throwing;
`normalizeEmail` trims+lowercases; a grant signed under a different
`GATE_SECRET` is rejected. Needs no network. If `GATE_SECRET` is unset it uses
a test-only value and says so.

Expected output (verified 2026-07-18): nine `PASS` lines, then
`Result: 9/9 passed`, exit 0.

Interpretation: anything under 9/9 means `lib/gate.js` no longer matches its
contract — do not ship gate changes until restored. This is the L1 evidence
level in bunny-sharing-validation-and-qa and a mandatory pre-push check for
gate.js edits per bunny-sharing-change-control.

## 2. kv-inspect.mjs — what is actually in Redis

```bash
node .claude/skills/bunny-sharing-diagnostics/scripts/kv-inspect.mjs            # table
node .claude/skills/bunny-sharing-diagnostics/scripts/kv-inspect.mjs --json     # raw dump
node .claude/skills/bunny-sharing-diagnostics/scripts/kv-inspect.mjs --token <t> # one record
```

Lists every `bunnyshare:*` record (token prefix, status Active/Expired/Revoked,
title, email, expiry) plus a count of live `gatethrottle:*` keys (30-second
magic-link throttle markers — a nonzero count means someone requested a
sign-in link within the last 30 s).

**Note (2026-09-13, `5eb7245`): this script predates three key namespaces
and does not know about them.** It will not show `gateused:*` (single-use
magic-link markers), `gateip:*` (per-IP rate-limit counters) or
`accessreq:*` (access-request throttles), and its status column does not
know about the `maxViews` cap, so a share that is "Used up" still prints as
Active. Until the script is updated, inspect those directly:

```bash
# per-IP counter — the one that silently eats your test magic links
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/get/gateip:<your-ip>"
# clear it
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/gateip:<your-ip>"
```

All three namespaces self-expire and every one fails OPEN, so deleting any
of them degrades a protection temporarily but can never break a live link.

Expected output without env (verified 2026-07-18):
`MISSING ENV: KV_REST_API_URL, KV_REST_API_TOKEN. Source your .env.local and retry.` exit 2.

Interpretation table:

| Result | Meaning |
| --- | --- |
| Record you expected is absent | Share never created, cleaned up, or written under a different key — check the `bunnyshare:` prefix assumption |
| `KV error 401` | Wrong `KV_REST_API_TOKEN` |
| Status `Revoked`/`Expired` but recipient reports access | They hold a still-valid embed URL from before; revocation applies on next page load |
| Throttle count > 0 during "no email arrived" report | Second request within 30 s was silently swallowed by design — wait and retry |

## 3. email-probe.mjs — prove the email path live

```bash
node .claude/skills/bunny-sharing-diagnostics/scripts/email-probe.mjs --to you@example.com
```

Sends ONE test share-email through `lib/mailer.js`'s real `sendShareEmail`
(hence the real `deliver()` routing: Resend API iff `RESEND_API_KEY` is set,
else SMTP). Prints which path was selected before sending. Refuses to run
without an explicit `--to` (verified: exit 2 with usage text).

Expected output without email env (verified 2026-07-18):
`[info] deliver() path that will be used: SMTP (nodemailer)` then
`MISSING ENV for SMTP path: SMTP_HOST, SMTP_USER, SMTP_PASS …` exit 2.

Interpretation: `Resend API error: …` mentioning the domain → from-address not
on a verified Resend domain; SMTP connection/auth errors → host/port/TLS
mismatch (587 = STARTTLS, 465 = implicit TLS; see email-delivery-reference).
PASS only means the provider *accepted* the message — inbox arrival (spam
folder, delays) is a separate deliverability question.

## 4. bunny-probe.mjs — Bunny connectivity and signing

```bash
node .claude/skills/bunny-sharing-diagnostics/scripts/bunny-probe.mjs
```

Calls the app's own `listVideos()`, prints the count and first three titles,
builds a signed embed URL for the first video, and — if `BUNNY_PULL_ZONE` is
set — HTTP-HEADs the signed thumbnail URL and interprets the status.

Expected output without env (verified 2026-07-18):
`MISSING ENV: BUNNY_LIBRARY_ID, BUNNY_API_KEY, BUNNY_TOKEN_KEY.` exit 2.

| Result | Meaning |
| --- | --- |
| `Bunny API error: 401` | Wrong `BUNNY_API_KEY` |
| `Bunny API error: 404` | Wrong `BUNNY_LIBRARY_ID` |
| Thumbnail HEAD 200 | Pull-zone auth OK (or token auth disabled) |
| Thumbnail HEAD 403 | `BUNNY_CDN_TOKEN_KEY` missing/wrong while pull-zone Token Authentication is ON — the two-keys trap (bunny-stream-reference) |

## 5. sign-check.mjs — is this signed URL wrong, or is my key wrong?

```bash
node .claude/skills/bunny-sharing-diagnostics/scripts/sign-check.mjs --url "<signed url>"
```

Parses `token`/`expires` from a signed Bunny URL, detects the scheme by host
(`iframe.mediadelivery.net` → embed/`BUNNY_TOKEN_KEY`, sha256-hex; anything
else → CDN/`BUNNY_CDN_TOKEN_KEY`, sha256-base64url), recomputes the signature
with your local env key, and reports:

- `MATCH` + not expired → key is correct; a 403 must be Bunny-side config.
- `MATCH` + `EXPIRED Ns ago` → the 403 is just expiry; re-render the page.
- `MISMATCH` → your env key differs from whatever signed the URL (or you fed
  an embed URL while holding only the CDN key, or vice versa).

Verified round-trip 2026-07-18: URL generated by `lib/bunny.js
generateEmbedUrl` with a test key → MATCH (exit 0); same URL checked under a
different key → MISMATCH (exit 1); CDN-scheme URL built with signCdnUrl's math
→ MATCH. The script's math mirrors `lib/bunny.js` exactly.

## Interpreting server log strings

| Log string | Origin | Meaning |
| --- | --- | --- |
| `KV error <status>: <body>` | lib/kv.js kvFetch | Upstash REST rejected the call; 401 = token, 4xx other = malformed key/value |
| `Resend API error: <msg>` | lib/mailer.js deliver() | Resend HTTP API rejected the send; message usually names the cause (domain, from, rate) |
| `GATE_SECRET is not set…` | lib/gate.js secret() | Runtime 500 on /watch or request-link; set the env var |
| `Bunny API error: <status> <body>` | lib/bunny.js listVideos | Bunny Stream API rejected the list call |

## When NOT to use this skill

- You have a symptom and don't know what to measure → bunny-sharing-debugging-playbook routes you to the right probe.
- You want the full live-certification protocol for the email gate → bunny-sharing-email-gate-campaign (it invokes these scripts at its gates).
- You're setting up env vars for the first time → bunny-sharing-env-and-setup.

## Provenance and maintenance

Facts verified 2026-07-18 against branch claude/bulk-share-separate-links-auth-cblrle.

- Scripts still import real code: `node .claude/skills/bunny-sharing-diagnostics/scripts/gate-selftest.mjs` (expect 9/9).
- Signing math still mirrors the lib: `grep -n "sha256" lib/bunny.js scripts 2>/dev/null; grep -n "sha256" .claude/skills/bunny-sharing-diagnostics/scripts/sign-check.mjs` — hash inputs must stay `key+videoId+expires` (hex) and `key+pathname+expires` (base64url).
- deliver() branch rule unchanged: `grep -n "RESEND_API_KEY" lib/mailer.js`.
- KV REST pattern unchanged: `sed -n '9,17p' lib/kv.js` vs kv-inspect.mjs's kvFetch.
- Log strings: `grep -rn "KV error\|Resend API error\|GATE_SECRET is not set\|Bunny API error" lib/`.
