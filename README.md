# Bunny Video Sharing

A small Next.js app for sharing private [Bunny.net Stream](https://bunny.net/stream/) videos with people outside your organization via time-limited, revocable links — without giving them access to your Bunny library.

See [FEATURES.md](./FEATURES.md) for the full feature list and [CHANGELOG.md](./CHANGELOG.md) for what changed and when.

## How it works

- The admin page (`/`) is protected with HTTP Basic Auth and lists videos from your Bunny Stream library.
- From there you generate a share: pick a video, enter a recipient email and an expiry window, and the app emails them a link like `/watch/<token>`. You can also **select multiple videos and bulk-share them to multiple recipients at once** — every recipient × video pair gets its own separate, independently revocable link, and each recipient receives one email listing only their own links. Repeat shares to the **same email address** (single or bulk, in any order) fold into that recipient's existing bundle and consolidate into one email, rather than sending a new standalone notification every time.
- Every recipient with more than one active share also gets a **bundle page** — one gated link listing everything shared with them. Verifying once unlocks the whole bundle (every video plays without a second email round-trip), while each video still independently enforces its own revoke/expiry.
- Each video also has a **Private list** button for YouTube-style private-video sharing: a persistent, editable invite list you maintain over time instead of one-off links. Add emails and only the ones that are actually new to that video's list get created as a share — re-adding someone already on the list does nothing. A **"Notify new people by email"** checkbox (on by default, like Google Drive/YouTube sharing) controls whether each newly added person actually gets an email; their link is live either way, so you can grant access and hand out the link yourself if you'd rather not send a notification. Remove someone and their link is revoked immediately; if you invite that email again later, it's treated as a fresh invite. This sits on top of the same share/bundle machinery as regular Share/Bulk Share, it's just a different way of managing who currently has access to one video.
- **Viewer groups** let you save a named list of emails (e.g. "Team A") once and insert it into Bulk Share or a Private list from a dropdown instead of retyping recipients — manage them from the "👥 Viewer groups" panel. A group is just a label on a set of emails; it grants no access itself and doesn't affect shares already sent to its members.
- **Per-collection sharing**: if your Bunny Stream library organizes videos into collections, the admin page shows a button per collection above the video grid — clicking it selects every video in that collection, feeding straight into the same Bulk Share flow as a hand-picked selection.
- Views are tracked per link (count + last viewed), and real playback is tracked via the Bunny player's events (plays, furthest progress %, completed) so you can see who actually watched — not just who opened the page. A collapsible **Analytics** panel rolls this up per video (shares, distinct recipients, views, started, completed + completion rate, average progress).
- You can optionally **watermark** the recipient's verified email across the player to deter and attribute leaks. It's controlled in layers — exempt emails/domains that are never watermarked (e.g. internal admins), a per-share Always/Never override (Share forms), a per-video Always/Never override (select on each Videos row), and a global default (admin **Settings** panel) — resolved most-specific-first as exemption → per-share → per-video → global default. It's a client-side overlay for attribution, not burned into the video, so it's a deterrent, not DRM.
- Returning recipients get a **Resume from where they left off** prompt (or Start over); the player reports a throttled position while watching and the watch page seeks to it on request.
- The `/watch/[token]` page is public (not behind Basic Auth) so recipients can open it directly. It's **email-gated**: the recipient must enter the address the link was shared with, and only if it matches does the app email them a one-time "magic link". Clicking that link sets a signed, link-scoped cookie and plays the video. Possessing the share URL alone is not enough — you also have to control the inbox it was sent to. Links that are revoked or expired never render.
- An optional **geo location whitelist** can further restrict every `/watch` and `/bundle` page, checked before the email gate, and the **admin page itself** can be geo-restricted too, on top of its credentials. Both country lists are set via env vars (`GEO_WHITELIST` / `ADMIN_GEO_WHITELIST`), not the admin UI — the Settings panel only has an ON/OFF toggle for each (off by default) and a read-only display of what's configured, so a lockout is always recoverable from your hosting dashboard rather than trapped behind the page it protects. Both fail open (never block) off Vercel or in local dev, since detection relies on Vercel's edge network. `ADMIN_GEO_BYPASS_EMAILS` lists Basic Auth usernames that always skip the admin geo check — a standing exemption meant to be armed before traveling, not an in-the-moment fix.
- The admin table supports **Resend, Extend, and Revoke** per link, each also available as a bulk action across multiple selected links at once. Extending a share gives a recipient more time without changing their link; resend re-sends the notification on demand (not just after a delivery failure); revoke is idempotent and never deletes the record — just flips a flag. A revoked link also shows a **Restore** button that flips the flag back (same token/URL/cookie), kept as its own explicit action rather than folded into Extend, and a **Delete permanently** button that removes the record outright (same deletion `/api/cleanup` does in bulk, on demand for one link) — only available once a share is already revoked, so it's always a deliberate second step, not a shortcut around Revoke. Any share that belongs to a bundle also shows a persistent link to its bundle page right in the table, not just in the one-time toast shown after sharing.
- Share records (token, video, recipient, expiry, revoked flag) are stored in Upstash Redis via the REST API.
- Expired/revoked shares can be purged with a cleanup endpoint, suitable for a scheduled job.

## Requirements

- A [Bunny.net](https://bunny.net/) account with a Stream library and pull zone
- An [Upstash](https://upstash.com/) Redis database (REST API), or the equivalent from the Vercel Storage tab
- An email provider for sending share emails — [Resend](https://resend.com/) (via its API, recommended) or any SMTP provider (Brevo, SMTP2GO, Gmail app password, etc.)

## Getting started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env.local` and fill in the values (see below).

3. Run the dev server:

   ```bash
   npm run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000) and sign in with `ADMIN_USER` / `ADMIN_PASS`.

## Environment variables

| Variable | Description |
| --- | --- |
| `BUNNY_LIBRARY_ID` | Bunny Stream library ID |
| `BUNNY_API_KEY` | Bunny Stream library API key |
| `BUNNY_TOKEN_KEY` | Bunny token authentication key, used to sign embed URLs |
| `BUNNY_PULL_ZONE` | Bunny Stream pull zone hostname |
| `BUNNY_CDN_TOKEN_KEY` | Pull zone's Token Authentication key. Only needed if Token Authentication is enabled on the pull zone (thumbnails will 403 without it). Found under Library > API > "CDN zone management" > Manage > Security > Token Authentication — **not** the same key as `BUNNY_TOKEN_KEY`. |
| `SITE_URL` | **Required.** Public base URL used when building every emailed link (e.g. `https://your-app.example.com`, or `http://localhost:3000` in dev). The app fails loudly if it's unset — it deliberately never falls back to the request's Host header, which a client can spoof (host header poisoning). |
| `ADMIN_USER` / `ADMIN_PASS` | Credentials for Basic Auth on `/` and its API routes |
| `GEO_WHITELIST` | Optional comma/space-separated ISO country codes (e.g. `US, CA`) allowed to reach `/watch` and `/bundle` pages. Also requires enabling it in the Settings panel (off by default). Deliberately an env var, not a Settings field, so the list can't be mistyped and saved instantly. |
| `ADMIN_GEO_WHITELIST` | Same idea, for the admin page/API, on top of the credentials above. Also requires enabling it in the Settings panel (off by default). An env var for the same reason, plus: it must stay editable outside the app so a lockout is always fixable from your hosting dashboard, not locked behind the very page it protects. |
| `ADMIN_GEO_BYPASS_EMAILS` | Optional comma/space-separated Basic Auth usernames (case-insensitive) that always skip the admin geo check above, regardless of country or the toggle. Arm this before traveling — it's a standing safety net, not an in-the-moment fix, since env var changes need a redeploy. |
| `GATE_SECRET` | Long random secret used to sign the email-gate magic links and viewer cookies (e.g. `openssl rand -hex 32`). Required for `/watch` pages. |
| `RESEND_API_KEY` / `RESEND_FROM` | Preferred email delivery: when `RESEND_API_KEY` is set, emails are sent via the [Resend](https://resend.com/) HTTP API. `RESEND_FROM` is a verified sender on your Resend domain. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Fallback SMTP settings, used only when `RESEND_API_KEY` is not set. Works with any SMTP provider (Brevo, SMTP2GO, Gmail app password, etc.). |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash Redis REST API credentials for storing share records |

## API routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/videos` | GET | List videos from the Bunny library, each with its `collectionId`, plus the library's `collections` (name + video count) |
| `/api/share` | POST | Create a share link and email it to a recipient. Folds into the recipient's existing bundle (see below) if they already have one. |
| `/api/share-bulk` | POST | Create a separate link per recipient × video pair; each recipient gets one email listing everything currently active for them. Accepts an optional `groupIds` array — each named viewer group's members are resolved and folded into the recipient list alongside any typed `emails` |
| `/api/video-invite` | GET / POST | Per-video private access list ("invite as a list", like a private YouTube video). GET `?videoId=` returns the current list with each member's live status. POST `{videoId, videoTitle, emails, groupIds, hours, watermark, notify}` adds any emails (plus each named viewer group's members) not already on the list — each becomes a normal share (same as `/api/share`); unless `notify` is explicitly `false`, each new addition also gets the usual notification email (a Drive/YouTube-style "don't send an email" option — the link is still live either way). Emails already on the list are left untouched (no new record, no re-sent email) |
| `/api/video-invite/remove` | POST | Remove one email from a video's invite list (`{videoId, email}`) and revoke their underlying share immediately. Re-adding the same email later is treated as a brand new invite |
| `/api/groups` | GET / POST | List named viewer groups, or create one (`{name, emails}`) |
| `/api/groups/[groupId]` | GET / PUT / DELETE | Read, update (`{name?, emails?}`), or delete one viewer group |
| `/api/shares` | GET | List all share records (for the admin table) |
| `/api/settings` | GET / POST | Read or update global admin settings (watermark default + exempt emails/domains), stored in the `bunnysettings:global` KV record |
| `/api/video-watermark` | POST | Set or clear one video's watermark override (`{videoId, choice}` where choice is `on`/`off`/`default`), stored in the same settings record |
| `/api/revoke` | POST | Revoke a share by token. Idempotent. |
| `/api/revoke-bulk` | POST | Revoke multiple shares by token in one call; reports success/failure per token |
| `/api/unrevoke` | POST | Restore a revoked share by token (flips the flag back). Idempotent. |
| `/api/revoke-permanent` | POST | Permanently delete a share by token. Only allowed once the share is revoked; irreversible. |
| `/api/share/resend` | POST | Re-send a share's notification email on demand, for any active share (not only ones that previously failed) |
| `/api/share/resend-bulk` | POST | Resend for multiple shares in one call; reports success/failure per token |
| `/api/share/extend` | POST | Extend a share's expiry in place (`{token, hours}`) — same link, longer validity. Works on an already-expired (not revoked) share. Refuses revoked shares. |
| `/api/share/extend-bulk` | POST | Extend multiple shares in one call; reports success/failure per token |
| `/api/cleanup` | POST | Delete expired or revoked share records, and bundle records that are either expired or have no live members left |
| `/api/backfill-index` | POST | One-time migration: populates the share/bundle index sets from a full scan, for records that existed before the index did. Idempotent — safe to re-run. Also in the admin UI as "🔁 Rebuild index". |
| `/api/watch/request-link` | POST | Public: verify a recipient's email against a share and email them a one-time magic link (excluded from admin Basic Auth) |
| `/api/watch/track` | POST | Public: record playback events (play/progress/ended) reported by the player; requires a token-bound tracking grant issued by the authorized watch page |
| `/api/bundle/request-link` | POST | Public: verify a recipient's email against their bundle and email them a one-time magic link that unlocks every video in it |

`/watch/[token]` and `/bundle/[bundleId]` are the two public, recipient-facing pages — neither is behind Basic Auth. Every other route is protected by the Basic Auth middleware.

## Deployment

Deploys as a standard Next.js app (e.g. on Vercel). Set the environment variables above in your hosting provider, and optionally schedule `/api/cleanup` (e.g. a Vercel Cron job) to periodically purge stale share records.

If you're upgrading an existing deployment that already has share/bundle records in Redis, click **🔁 Rebuild index** in the admin table once after deploying (or `POST /api/backfill-index`) — the admin listing and cleanup now read an index instead of scanning the whole keyspace, so pre-existing records need to be indexed once to keep showing up. Not needed on a fresh deployment. Existing `/watch`/`/bundle` links are unaffected either way — they never depended on the index.
