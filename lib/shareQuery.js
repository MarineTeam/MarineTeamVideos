import { kvGet, kvSmembers } from "./kv";
import { SHARE_INDEX_KEY } from "./shares";

// Shared read/filter layer for the admin shares listing (/api/shares) and
// the CSV export (/api/shares/export), so the two can never disagree about
// what "active" means or which rows a filter selects.
//
// Honest note on cost: this still reads EVERY share record on each call
// (SMEMBERS on the index, then one GET per token). It has to, because the
// listing is ordered newest-first and filtered by fields — createdAt, email,
// title, revoked — that live inside the records themselves, and there is no
// secondary index carrying them. Paging here therefore cuts the RESPONSE
// size and the work the admin page's browser does, which is what actually
// hurts at a few hundred shares; it does NOT cut the number of KV reads.
// Cutting those needs a sorted index keyed by createdAt, which is a
// bigger, separately-verifiable change.

// One share's lifecycle state, derived live from the record — never stored,
// so it can't go stale. Order matters: revoked beats expired, because a
// revoked-then-expired share is still fundamentally an admin cutoff.
export function shareStatus(record, now = Date.now()) {
  if (record.revoked) return "revoked";
  if (now > record.expiresAt) return "expired";
  if (record.maxViews && (record.viewCount || 0) >= record.maxViews) return "exhausted";
  return "active";
}

export async function loadAllShares() {
  const tokens = await kvSmembers(SHARE_INDEX_KEY);
  const records = await Promise.all(tokens.map((t) => kvGet(`bunnyshare:${t}`)));
  return records.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}

// Applies the admin listing's filters. `status` is one of the shareStatus
// values (or "failed" for shares whose notification email failed, or "all");
// `q` is a case-insensitive substring matched against recipient email and
// video title. Unknown values fall through as no filter, so a malformed
// query string can never empty the table by accident.
export function filterShares(shares, { status, q } = {}) {
  const now = Date.now();
  let out = shares;

  if (status === "failed") {
    out = out.filter((s) => s.emailFailed);
  } else if (["active", "expired", "revoked", "exhausted"].includes(status)) {
    out = out.filter((s) => shareStatus(s, now) === status);
  }

  const needle = String(q || "").trim().toLowerCase();
  if (needle) {
    out = out.filter(
      (s) =>
        String(s.email || "").toLowerCase().includes(needle) ||
        String(s.videoTitle || "").toLowerCase().includes(needle)
    );
  }

  return out;
}

// Clamped so a hand-edited query string can't ask for a million-row page.
export function paginate(rows, { page, pageSize } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
  const pageCount = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(Number(page) || 1, 1), pageCount);
  const start = (current - 1) * size;
  return {
    rows: rows.slice(start, start + size),
    page: current,
    pageSize: size,
    pageCount,
    total: rows.length,
  };
}

// Per-video rollup of the tracking already stored on each share. Lives here,
// beside the listing helpers, because it MUST see every share rather than
// the current page — when the table became server-side paged, computing this
// in the browser from the rows on screen would have silently turned it into
// "analytics for the 50 most recent shares". No extra data is collected for
// it; every number is derived from fields the share records already carry.
export function computeAnalytics(shares) {
  const byVideo = new Map();
  for (const s of shares) {
    const key = s.videoId;
    let a = byVideo.get(key);
    if (!a) {
      a = {
        videoId: key,
        title: s.videoTitle || key,
        shares: 0,
        recipients: new Set(),
        views: 0,
        started: 0,
        completed: 0,
        progressSum: 0,
        progressCount: 0,
      };
      byVideo.set(key, a);
    }
    a.shares += 1;
    if (s.email) a.recipients.add(String(s.email).toLowerCase());
    a.views += s.viewCount || 0;
    if (s.playCount || s.maxProgressPct || s.completedAt) a.started += 1;
    if (s.completedAt) a.completed += 1;
    if (s.maxProgressPct) {
      a.progressSum += s.maxProgressPct;
      a.progressCount += 1;
    }
  }
  return [...byVideo.values()]
    .map((a) => ({
      videoId: a.videoId,
      title: a.title,
      shares: a.shares,
      recipients: a.recipients.size,
      views: a.views,
      started: a.started,
      completed: a.completed,
      completionRate: a.shares ? Math.round((a.completed / a.shares) * 100) : 0,
      avgProgress: a.progressCount ? Math.round(a.progressSum / a.progressCount) : 0,
    }))
    .sort((x, y) => y.shares - x.shares || y.views - x.views);
}
