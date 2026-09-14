import nodemailer from "nodemailer";
import { Resend } from "resend";

function escapeHtml(text) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return String(text).replace(/[&<>"']/g, (char) => map[char]);
}

function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Renders an optional admin-supplied note as the opening block of a
// notification email. The note is user-controlled text, so the HTML side
// goes through escapeHtml like every other interpolated value (invariant 2)
// and newlines become <br/> only AFTER escaping — never before, or the
// escaping could be bypassed by a crafted note.
function noteBlocks(note) {
  const text = String(note || "").trim();
  if (!text) return { text: "", html: "" };
  return {
    text: `${text}\n\n`,
    html: `<p style="white-space:pre-wrap">${escapeHtml(text).replace(/\n/g, "<br/>")}</p>`,
  };
}

function fromAddress() {
  return process.env.RESEND_FROM || process.env.SMTP_FROM || process.env.SMTP_USER;
}

// Single delivery path for every email in this app. Uses the Resend HTTP API
// when RESEND_API_KEY is set (the native, recommended way to use Resend), and
// otherwise falls back to plain SMTP via nodemailer so any other provider still
// works. Callers only build { to, subject, text, html }.
async function deliver({ to, subject, text, html }) {
  const from = fromAddress();

  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({ from, to, subject, text, html });
    if (error) {
      throw new Error(`Resend API error: ${error.message || JSON.stringify(error)}`);
    }
    return;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  await transporter.sendMail({ from, to, subject, text, html });
}

export async function sendShareEmail({ to, videoTitle, link, expiresAt, note }) {
  if (!isValidUrl(link)) {
    throw new Error("Invalid link URL");
  }

  const expiresDate = new Date(expiresAt).toLocaleString();
  const escapedTitle = escapeHtml(videoTitle);
  const escapedLink = escapeHtml(link);
  const escapedDate = escapeHtml(expiresDate);
  const noteBlock = noteBlocks(note);

  await deliver({
    to,
    subject: `You've been granted access to "${escapedTitle}"`,
    text: `${noteBlock.text}You can watch "${videoTitle}" here:\n\n${link}\n\nThis link expires on ${expiresDate} and may be revoked at any time.`,
    html: `${noteBlock.html}<p>You can watch <strong>${escapedTitle}</strong> using the link below:</p>
           <p><a href="${escapedLink}">${escapedLink}</a></p>
           <p>This link expires on ${escapedDate} and may be revoked at any time.</p>`,
  });
}

// Sends one consolidated email listing several share links, one per video.
// Each item is { videoTitle, link } and carries its own distinct token.
// `bundleLink`, if given and valid, adds a single link to a listing page for
// all of them (see lib/bundles.js) — purely additive to the email body.
export async function sendBulkShareEmail({ to, items, expiresAt, bundleLink, note }) {
  const safeItems = items.filter((i) => isValidUrl(i.link));
  if (safeItems.length === 0) {
    throw new Error("No valid link URLs");
  }

  const expiresDate = new Date(expiresAt).toLocaleString();
  const escapedDate = escapeHtml(expiresDate);
  const validBundleLink = bundleLink && isValidUrl(bundleLink) ? bundleLink : null;
  const escapedBundleLink = validBundleLink ? escapeHtml(validBundleLink) : null;

  const noteBlock = noteBlocks(note);
  const textLines = safeItems.map((i) => `${i.videoTitle}:\n${i.link}`).join("\n\n");
  const htmlItems = safeItems
    .map(
      (i) =>
        `<li><strong>${escapeHtml(i.videoTitle)}</strong><br/>` +
        `<a href="${escapeHtml(i.link)}">${escapeHtml(i.link)}</a></li>`
    )
    .join("");

  await deliver({
    to,
    subject: `You've been granted access to ${safeItems.length} video${safeItems.length !== 1 ? "s" : ""}`,
    text: `${noteBlock.text}You've been granted access to the following videos. Each has its own link:\n\n${textLines}\n\n${validBundleLink ? `Or view them all in one place:\n${validBundleLink}\n\n` : ""}These links expire on ${expiresDate} and may be revoked at any time.`,
    html: `${noteBlock.html}<p>You've been granted access to the following videos. Each has its own link:</p>
           <ul>${htmlItems}</ul>
           ${validBundleLink ? `<p>Or <a href="${escapedBundleLink}">view them all in one place</a>.</p>` : ""}
           <p>These links expire on ${escapedDate} and may be revoked at any time.</p>`,
  });
}

// Sends the "magic link" that a recipient clicks after entering the matching
// email on the /watch page. The link carries a short-lived signed grant.
export async function sendMagicLinkEmail({ to, videoTitle, link }) {
  if (!isValidUrl(link)) {
    throw new Error("Invalid link URL");
  }

  const escapedTitle = escapeHtml(videoTitle);
  const escapedLink = escapeHtml(link);

  await deliver({
    to,
    subject: `Your sign-in link for "${escapedTitle}"`,
    text: `Use the link below to watch "${videoTitle}". It confirms it's really you and expires shortly:\n\n${link}\n\nIf you didn't request this, you can ignore this email.`,
    html: `<p>Use the link below to watch <strong>${escapedTitle}</strong>. It confirms it's really you and expires shortly:</p>
           <p><a href="${escapedLink}">Watch "${escapedTitle}"</a></p>
           <p>If you didn't request this, you can ignore this email.</p>`,
  });
}

// Sends the "magic link" for a bundle listing page (lib/bundles.js) rather
// than a single video — same mechanism as sendMagicLinkEmail, generic wording
// since there's no single title to name.
export async function sendBundleMagicLinkEmail({ to, link }) {
  if (!isValidUrl(link)) {
    throw new Error("Invalid link URL");
  }

  const escapedLink = escapeHtml(link);

  await deliver({
    to,
    subject: `Your sign-in link for your shared videos`,
    text: `Use the link below to view your shared videos. It confirms it's really you and expires shortly:\n\n${link}\n\nIf you didn't request this, you can ignore this email.`,
    html: `<p>Use the link below to view your shared videos. It confirms it's really you and expires shortly:</p>
           <p><a href="${escapedLink}">View your videos</a></p>
           <p>If you didn't request this, you can ignore this email.</p>`,
  });
}

// ---------------------------------------------------------------------------
// Admin-facing notifications. Both go to ADMIN_NOTIFY_EMAIL (never to a
// recipient), and both interpolate recipient-controlled values — the email
// address someone typed, a video title from Bunny — so every one of them is
// escaped exactly like the recipient-facing templates above (invariant 2).
// ---------------------------------------------------------------------------

// Where admin notifications go. Falls back to the configured from-address so
// a deployment that sets a sender but forgets ADMIN_NOTIFY_EMAIL still
// reaches someone, rather than silently dropping the notification.
export function adminNotifyAddress() {
  return process.env.ADMIN_NOTIFY_EMAIL || fromAddress();
}

// Sent the first time a recipient actually plays a given share. Fires at
// most once per share (keyed off the record's firstPlayedAt), so this can
// never become a per-view firehose.
export async function sendFirstPlayNotificationEmail({ to, videoTitle, recipientEmail, viewedAt }) {
  const escapedTitle = escapeHtml(videoTitle);
  const escapedEmail = escapeHtml(recipientEmail);
  const when = new Date(viewedAt).toLocaleString();
  const escapedWhen = escapeHtml(when);

  await deliver({
    to,
    subject: `First play: "${escapedTitle}"`,
    text: `${recipientEmail} started watching "${videoTitle}" at ${when}.\n\nThis is the first time this share has been played. You'll only get one of these per share.`,
    html: `<p><strong>${escapedEmail}</strong> started watching <strong>${escapedTitle}</strong> at ${escapedWhen}.</p>
           <p>This is the first time this share has been played. You'll only get one of these per share.</p>`,
  });
}

// Sent when a recipient whose link has expired asks for more time from the
// dead-link page. Deliberately carries NO free-text message from the
// requester: the endpoint is public, so anything it forwarded verbatim would
// be an unauthenticated channel for pushing text into the admin's inbox.
// The admin already has everything needed to act — who, which video, which
// token — from the record itself.
export async function sendAccessRequestEmail({ to, videoTitle, recipientEmail, token, expiredAt }) {
  const escapedTitle = escapeHtml(videoTitle);
  const escapedEmail = escapeHtml(recipientEmail);
  const escapedToken = escapeHtml(token);
  const when = new Date(expiredAt).toLocaleString();
  const escapedWhen = escapeHtml(when);

  await deliver({
    to,
    subject: `Access request: "${escapedTitle}"`,
    text: `${recipientEmail} is asking for more time on "${videoTitle}", which expired on ${when}.\n\nShare token: ${token}\n\nTo restore access, open your admin page and use Extend on that share — the recipient's existing link keeps working.`,
    html: `<p><strong>${escapedEmail}</strong> is asking for more time on <strong>${escapedTitle}</strong>, which expired on ${escapedWhen}.</p>
           <p>Share token: <code>${escapedToken}</code></p>
           <p>To restore access, open your admin page and use <strong>Extend</strong> on that share — the recipient's existing link keeps working.</p>`,
  });
}
