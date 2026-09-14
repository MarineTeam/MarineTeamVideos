---
name: email-delivery-reference
description: >
  Email domain pack for bunny-sharing: how lib/mailer.js's single deliver()
  routes between the Resend HTTP API and nodemailer SMTP, which env vars each
  branch reads, Resend domain verification and the SMTP bridge, STARTTLS (587)
  vs implicit TLS (465), SPF/DKIM deliverability basics, and the security
  checklist for adding any new email template. Load this when you need to
  UNDERSTAND or MODIFY the email path — changing deliver(), adding a sender or
  template, switching providers, or reasoning about why a config would fail.
  Do NOT load this first for "email not arriving" triage (use
  bunny-sharing-debugging-playbook), for sending a live test email (use
  bunny-sharing-diagnostics), or for the general env-var catalog (use
  bunny-sharing-env-and-setup).
---

# Email Delivery Reference (bunny-sharing)

Everything email in this app flows through **one function**: `deliver()` in
`lib/mailer.js`. There is no queue, no retry, no background worker — every send
is a synchronous `await` inside an API route handler. This skill is the domain
knowledge you need before touching that path, plus the minimum protocol theory
(Resend API, SMTP/STARTTLS, SPF/DKIM) that a zero-context session needs to
reason about it correctly.

All line numbers refer to the repo as of 2026-07-18 (branch
`claude/bulk-share-separate-links-auth-cblrle`, commit `5905bba`). Re-verify
with the commands in "Provenance and maintenance" before trusting them.

## 1. The deliver() routing contract

`lib/mailer.js:32-54`. Callers only ever build `{ to, subject, text, html }`;
`deliver()` decides HOW it is sent. The branch rule is a single check:

```
if RESEND_API_KEY is set  → Resend HTTP API  (resend SDK, resend.emails.send)
else                      → plain SMTP        (nodemailer.createTransport + sendMail)
```

Key facts, each verifiable in `lib/mailer.js`:

- **From address** (`fromAddress()`, lib/mailer.js:24-26):
  `RESEND_FROM || SMTP_FROM || SMTP_USER`. This fallback chain applies to BOTH
  branches — a Resend send with only SMTP_FROM set will use SMTP_FROM.
- **Resend errors** (lib/mailer.js:37-40): the SDK returns `{ error }` instead
  of throwing; `deliver()` converts it to a thrown
  `Error("Resend API error: <message>")`. So any error message starting with
  `Resend API error:` means the API branch ran — instantly tells you which
  branch a failure came from.
- **SMTP branch** (lib/mailer.js:44-53): fresh transporter per call,
  `port: Number(SMTP_PORT || 587)`, `secure: Number(SMTP_PORT) === 465`.
  No `verify()` call, no `requireTLS` — deliberately (see section 3).
- API route handlers (`pages/api/share.js:29-31`, `share-bulk.js`,
  `watch/request-link.js:60-62`) catch the thrown error and return
  `res.status(500).json({ error: err.message })`, so send failures surface as
  a 500 whose body contains the mailer message.
- **Ordering caveat**: in share/share-bulk the KV record is created BEFORE the
  email is sent (`pages/api/share.js:13-26`). A 500 from a send failure does
  NOT mean no share exists — the record is already stored.

### Which env vars are read in which branch

| Env var | Resend API branch | SMTP branch | Notes |
| --- | --- | --- | --- |
| `RESEND_API_KEY` | selects the branch + auths the SDK | ignored (its absence IS this branch) | presence check only — an empty string counts as unset |
| `RESEND_FROM` | from address (1st choice) | from address (1st choice) | fallback chain is shared |
| `SMTP_FROM` | from address (2nd choice) | from address (2nd choice) | |
| `SMTP_USER` | from address (3rd choice) | from + auth user | |
| `SMTP_HOST` | ignored | transport host | |
| `SMTP_PORT` | ignored | port (default 587) + drives `secure` | |
| `SMTP_PASS` | ignored | auth pass | |

Corollary worth stating plainly: **when `RESEND_API_KEY` is set, every
SMTP_HOST/PORT/PASS value is dead config.** You cannot "also" use SMTP; the
API branch returns before the transporter is ever built. If someone reports
"I changed SMTP_HOST and nothing happened", check for a set `RESEND_API_KEY`
first.

### The six senders

All are in `lib/mailer.js`; these are the only exports and the only email
the app ever sends. Four go to RECIPIENTS; two (added 2026-09-13,
`5eb7245`) go to the ADMIN via `adminNotifyAddress()` — `ADMIN_NOTIFY_EMAIL`
falling back to the same `fromAddress()` chain, so a deployment with neither
simply sends nothing and each call site guards on that.

| Sender | Called from | Trigger | Must contain |
| --- | --- | --- | --- |
| `sendShareEmail({to, videoTitle, link, expiresAt, note})` | `pages/api/share.js` | admin shares one video | the video title, the `/watch/<token>` link, the expiry date, "may be revoked" notice; the optional `note` opens the body |
| `sendBulkShareEmail({to, items, expiresAt, bundleLink, note})` | `pages/api/share-bulk.js`, and `pages/api/share.js` once a recipient has >1 active share | admin bulk-shares N videos, or a repeat share consolidates | one list item per video, each with its OWN distinct link (invariant: N videos = N tokens = N independently revocable links), shared expiry date, optional bundle link, optional opening `note` |
| `sendMagicLinkEmail({to, videoTitle, link})` | `pages/api/watch/request-link.js` | recipient types the matching email on `/watch/<token>` | the `/watch/<token>?grant=<signed>` magic link (15-min grant, SINGLE-USE since 2026-09-13), "expires shortly" wording, "ignore if you didn't request this" |
| `sendBundleMagicLinkEmail({to, link})` | `pages/api/bundle/request-link.js` | recipient types the matching email on `/bundle/<id>` | the `/bundle/<id>?grant=<signed>` magic link; generic wording (no single title to name) |
| `sendFirstPlayNotificationEmail({to, videoTitle, recipientEmail, viewedAt})` | `pages/api/watch/track.js` | ADMIN-facing: a share is played for the first time ever | who played what and when; the "one of these per share" reassurance |
| `sendAccessRequestEmail({to, videoTitle, recipientEmail, token, expiredAt})` | `pages/api/watch/request-access.js` | ADMIN-facing: recipient of an EXPIRED link asks for more time | who is asking, which video, the share token, and the instruction to use Extend (which keeps their existing link working) |

**The two admin senders interpolate recipient-controlled values** — an email
address typed by an anonymous visitor, a video title from the Bunny library
— so they carry exactly the same `escapeHtml` obligation as the
recipient-facing templates. `sendAccessRequestEmail` deliberately carries NO
free-text message from the requester: it is reachable from a PUBLIC endpoint,
and anything it forwarded verbatim would be an unauthenticated channel for
pushing attacker-chosen prose into the admin's inbox. Do not "improve" it by
adding a message field.

**The `note` field** (optional, on both share senders) is admin-supplied and
rendered by `noteBlocks()`. Note the ordering there: it escapes FIRST and
converts newlines to `<br/>` SECOND. Reversing that would let a crafted note
inject markup, since the `<br/>` insertion would then be escaped instead of
the content.

Behavioral details you must preserve when editing:

- `sendShareEmail` and `sendMagicLinkEmail` throw `"Invalid link URL"` if
  `isValidUrl(link)` fails, BEFORE any send.
- `sendBulkShareEmail` silently **filters** invalid-URL items
  (lib/mailer.js:79) and only throws (`"No valid link URLs"`) if none survive.
  Filtering vs throwing is intentional — a partial bulk email still delivers
  the valid links.
- Every sender provides BOTH `text` and `html` parts. Keep it that way
  (section 6).

## 2. Resend essentials, as they apply here

Resend (resend.com) is the preferred provider (README "Requirements" section,
`.env.example:23-27`). What a zero-context session needs to know:

- **API key**: starts with `re_`. Created in the Resend dashboard. Goes in
  `RESEND_API_KEY`. Setting it flips `deliver()` into the API branch — that is
  the entire switch.
- **Domain verification is a hard requirement for the from address.** Resend
  only accepts a `from` on a domain you have verified (DNS records added via
  the Resend dashboard). An unverified from domain does not spam-folder — it
  fails the API call outright, and you'll see it as a thrown
  `Resend API error: ...` (typically a validation/403-style message naming the
  domain). `.env.example:24-25` and README both say `RESEND_FROM` must be "a
  verified sender on your Resend domain" — this is why.
- **Sandbox sender for testing ONLY**: Resend allows sending from
  `onboarding@resend.dev` without verifying any domain, but only to the email
  address of the Resend account owner. Useful for a first smoke test of the
  API branch when no domain is verified yet; never usable for real recipients.
  Label any config using it as testing-only and do not leave it in production
  env.
- **Resend-via-SMTP bridge** (the alternate way to use Resend): Resend also
  exposes an SMTP endpoint. Config:
  `SMTP_HOST=smtp.resend.com`, `SMTP_PORT=587`, `SMTP_USER=resend`,
  `SMTP_PASS=<the re_... API key>`. **Critically, per deliver()'s branch rule
  this only takes effect when `RESEND_API_KEY` is UNSET** — if you set both,
  the API branch wins and the bridge config is dead. There is no reason to
  prefer the bridge here except as a discriminating experiment (e.g. proving
  an API-branch failure is not credential-related). The native API branch is
  the documented preferred path (lib/mailer.js:28-31 comment).

## 3. SMTP minimum theory (ports, TLS, and this code)

Two ways an SMTP connection gets encrypted:

- **Port 587 = STARTTLS (submission)**: the client connects in **plaintext**,
  the server advertises `STARTTLS`, and the connection is upgraded to TLS
  before authentication. In nodemailer terms this is `secure: false` — "not
  secure" describes only the initial connect, not the final channel.
- **Port 465 = implicit TLS (smtps)**: the connection is TLS **from the first
  byte**. Nodemailer: `secure: true`.

The code encodes this convention in one line (lib/mailer.js:47):

```js
secure: Number(process.env.SMTP_PORT) === 465,
```

So `secure` is derived from the port, never set independently. What breaks
when port and provider expectation disagree:

| Misconfig | What happens |
| --- | --- |
| Provider requires 465/implicit TLS, but `SMTP_PORT=587` | Client connects to port 587 with `secure:false`. If the provider doesn't listen on 587 → connection refused/timeout. If something answers 587 expecting implicit TLS, the plaintext SMTP greeting exchange fails → garbled-greeting / handshake error. Symptom class: connection-level errors before auth. |
| Provider requires 587/STARTTLS, but `SMTP_PORT=465` | Client opens a TLS handshake (`secure:true`) against a port serving plaintext-then-STARTTLS (or nothing). TLS handshake fails or hangs until timeout — typical errors: `ETIMEDOUT`, `ESOCKET`, `wrong version number`. Again fails before auth. |
| Correct port, wrong creds | Connection and TLS succeed, then auth fails — `EAUTH` / `535`. Different symptom class; use it to distinguish transport problems from credential problems. |

Also note `SMTP_PORT` defaults to 587 for the **port** number
(`SMTP_PORT || 587`, line 46) but the `secure` check reads the raw env var —
with `SMTP_PORT` unset, `Number(undefined) === 465` is false, so the default
is coherently "587 + STARTTLS".

**History note (do not regress):** commits 7490382/4d9189f/1a2e4db (2026-07-02)
added `requireTLS: true`, `tls: { rejectUnauthorized: true }`, env validation,
and a `transporter.verify()` call before every send, plus emoji console
logging. Commit **30ecd7f** (2026-07-03, "Fix") stripped all of it: the
per-send `verify()` added a full extra SMTP round-trip of latency and its
failures blocked sends, and the logging leaked recipient data to logs. The
current minimal transporter is the deliberate end state. **Do NOT reintroduce
per-send `verify()`** — if you need a connection check, that belongs in a
one-off diagnostic script (see bunny-sharing-diagnostics), not the send path.
Full story: bunny-sharing-failure-archaeology.

## 4. Deliverability primer (scoped to this app)

Definitions, once:

- **SPF**: a DNS TXT record on the from-domain listing which servers may send
  mail for it.
- **DKIM**: a cryptographic signature added by the sending provider, verified
  against a public key in the from-domain's DNS.
- Both live at the **provider/domain level**, not in this codebase. With
  Resend, you add the DNS records Resend's dashboard gives you when verifying
  the domain; Resend then signs outgoing mail. There is nothing to configure
  in this repo — if SPF/DKIM are wrong, the fix is in DNS + the Resend
  dashboard.

Distinguishing the three failure symptoms (theory behind the triage in
bunny-sharing-debugging-playbook — go there first for the actual sequence):

| Symptom | Where you see it | Meaning |
| --- | --- | --- |
| Unverified domain | Immediate `Resend API error: ...` thrown from `deliver()`; API route returns 500; NO email exists anywhere | Config problem. Verify the domain in the Resend dashboard or fix `RESEND_FROM`. |
| Spam-foldering | Send succeeds (200 from the API route), message exists but lands in Junk | Reputation/authentication problem: missing/weak DKIM alignment, new domain, spammy content. Check the message headers (`Authentication-Results`) in the received mail. |
| Hard bounce | Send call succeeds, then the provider generates a bounce (visible in the Resend dashboard logs; SMTP may return a 5xx at send time for immediate rejects) | Recipient problem: mailbox doesn't exist, or recipient server rejects. The app has no bounce webhook — the Resend dashboard is the only place bounces are visible. |

**Latency asymmetry — why the magic-link email is special:** when
`sendMagicLinkEmail` fires, the recipient is sitting on the `/watch/<token>`
page having just typed their email, actively waiting for their inbox to
refresh (`pages/api/watch/request-link.js`). Seconds matter, and the grant
inside the link expires in 15 minutes (`MAGIC_LINK_TTL_MS`,
request-link.js:8), so a greylisting delay of 10+ minutes can render the link
near-dead on arrival. Share and bulk-share emails have no one waiting — a
minutes-late delivery is invisible. Practical consequences: (a) judge any
provider/config change by magic-link latency, not share-email latency;
(b) never add latency to `deliver()` itself (this is exactly why the per-send
`verify()` was removed); (c) a "the sign-in link never comes" report can be
slow delivery, the 30-second per-token throttle (request-link.js:10,43-48),
or the anti-enumeration generic response hiding an email mismatch — all three
look identical to the recipient by design.

## 5. Security guards in the mail path

Incident **29fb9be** (2026-07-10): CodeQL flagged XSS in email HTML plus
host-header poisoning of generated links. The fix added two guards to
`lib/mailer.js` (and made `baseUrl()` in `lib/shares.js` fall back to https).
These are invariants — do not weaken:

- `escapeHtml()` (lib/mailer.js:4-13) — escapes `& < > " '`. Applied to EVERY
  interpolated string in every HTML part: titles, links, dates, list items.
- `isValidUrl()` (lib/mailer.js:15-22) — parses with `new URL()` and accepts
  only `http:`/`https:` protocols. Applied to every link before it is mailed
  (throw in single senders, filter in bulk — see section 1).

Why links get both guards: `isValidUrl` blocks `javascript:`-style protocols
and garbage; `escapeHtml` prevents a quote in the URL from breaking out of the
`href="..."` attribute.

### Checklist: adding or editing ANY email template

A new template is a change to a security-incident surface; run it through
bunny-sharing-change-control. Within the template itself, ALL of the
following, no exceptions:

1. Every dynamic string interpolated into the `html` part goes through
   `escapeHtml()` — including strings you "know" are safe (dates, counts).
   Video titles come from the Bunny API and recipient emails from admin input;
   treat both as untrusted.
2. Every URL placed in the email is checked with `isValidUrl()` first —
   throw (or filter, for list emails) on failure, before calling `deliver()`.
3. Build links from `baseUrl(req)` (`lib/shares.js`) — never from the raw Host
   header and never hardcoded.
4. Provide BOTH `text` and `html` parts (section 6). The `text` part uses the
   raw (unescaped) strings — it is not HTML; escaping there would corrupt it.
   Match the existing senders: escaped in `html`, raw in `text`.
5. Do not log recipient addresses or message contents (30ecd7f removed such
   logging deliberately).
6. Route the send through `deliver()` — never construct a transporter or
   Resend client anywhere else. One delivery path is the contract.
7. Do not add pre-send network calls (verify(), DNS checks) to the send path.

## 6. HTML email constraints

- Templates here are deliberately primitive: `<p>`, `<strong>`, `<a>`,
  `<ul>/<li>`, `<br/>`. No CSS, no images, no layout tables. Keep it that
  way — email client HTML support is archaic and inconsistent, and
  link-plus-sentence emails have nothing to gain from styling. (Observed
  convention, not user doctrine.)
- **Always provide both `text` and `html`.** All six senders do
  (lib/mailer.js:66-73, 96-103, 116-123). The multipart text alternative
  matters for deliverability scoring (html-only mail is a spam signal) and
  for text-mode clients. Preserve this in any new sender.
- The share-email subject interpolates `escapedTitle`
  (lib/mailer.js:68) even though subjects are plain text, so a title
  containing `&` renders as `&amp;` in the subject line. Cosmetic quirk, noted
  here so you don't "discover" it as a bug mid-task; changing it is a
  behavior change — go through change-control.

## When NOT to use this skill

- **"Email not arriving" / recipient reports no mail** → start with
  bunny-sharing-debugging-playbook (symptom→triage sequence). This skill is
  the theory BEHIND that playbook, not the playbook.
- **Sending a live test email / probing the configured provider** →
  bunny-sharing-diagnostics (executable email probe script).
- **Full env-var catalog and from-scratch setup** →
  bunny-sharing-env-and-setup. This skill covers only the email vars' branch
  semantics.
- **Proving the email gate end-to-end in production** →
  bunny-sharing-email-gate-campaign.
- **What the magic-link grant contains / how it verifies** → that is
  `lib/gate.js` territory: bunny-sharing-architecture-contract.

## Provenance and maintenance

Verified 2026-07-18 against commit `5905bba` on branch
`claude/bulk-share-separate-links-auth-cblrle`. Re-verify before relying on
volatile facts:

```bash
# Branch rule, from-chain, error wrapping, secure/port logic, six senders:
sed -n '24,54p' lib/mailer.js          # fromAddress + deliver()
grep -n "export async function" lib/mailer.js
# Call sites (should be exactly these three files):
grep -rn "sendShareEmail\|sendBulkShareEmail\|sendMagicLinkEmail\|sendBundleMagicLinkEmail\|sendFirstPlayNotificationEmail\|sendAccessRequestEmail" pages/
# Env var documentation still matches:
sed -n '23,35p' .env.example
# Magic-link TTL and throttle:
grep -n "MAGIC_LINK_TTL_MS\|THROTTLE_SECONDS" pages/api/watch/request-link.js
# History claims (hardening added then removed):
git show 30ecd7f -- lib/mailer.js | head -60
```

If `lib/mailer.js` gains a sender, a provider branch, or a queue/retry layer,
this skill's sections 1-3 must be rewritten, not patched. Resend product facts
(sandbox sender address, SMTP bridge host/port) are external and dated
2026-07-18 — confirm against resend.com docs if a send against them fails.
