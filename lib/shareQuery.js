import { kvGet, kvSmembers, kvZcard, kvZrangeRev } from "./kv";
import { SHARE_INDEX_KEY, SHARE_BY_CREATED_KEY } from "./shares";

// Shared read/filter layer for the admin shares listing (/api/shares) and
// the CSV export (/api/shares/export), so the two can never disagree about
// what "active" means or which rows a filter selects.
//
// Cost, precisely — there are two read paths and they differ:
//
//  * UNFILTERED listing (the default admin view, loaded on every page open)
//    uses `loadSharePage` below: one ranked range read against the
//    createdAt-ordered index plus one GET per row actually shown. Bounded;
//    it does not grow with the number of shares.
//  * FILTERED or SEARCHED listing still uses `loadAllShares`: SMEMBERS then
//    one GET per token. It has to, because status is derived and
//    time-dependent and search is a substring match — neither can be
//    answered from an index without introducing a second source of truth
//    that disagrees with the records (see roadmap item (m)'s rejected
//    options). This is unchanged from before the ordered index existed, so
//    filtering is no slower than it ever was; it is simply not faster.
//
// `/api/analytics` is deliberately a full reader: a rollup legitimately
// needs every record, and computing it from one page would silently report
// "analytics for the latest 50 shares" (failure-archaeology Episode 12).

// One share's lifecycle state, derived live from the record — never stored,
// so it can't go stale. Order matters: revoked beats expired, because a
// revoked-then-expired share is still fundamentally an admin cutoff.
export function shareStatus(record, now = Date.now()) {
  if (record.revoked) return "revoked";
  if (now > record.expiresAt) return "expired";
  if (record.maxViews && (record.viewCount || 0) >= record.maxViews) return "exhausted";
  return "active";
}

// One page of shares, newest first, read from the ordered index.
//
// Falls back to the full read whenever the ordered index cannot serve the
// request — it is empty (a deployment that upgraded without running the
// backfill), it is shorter than the plain index (mid-backfill), or the
// range read throws (an unavailable store, or a sorted-set command shape the
// provider does not accept). That fallback is load-bearing rather than
// defensive politeness: without it, an un-backfilled deployment would show
// an EMPTY admin table, which is precisely the silent-migration failure that
// orphaned records in 30ecd7f. A listing that is merely slow is always
// preferable to one that is wrong.
//
// Returns the same shape as the filtered path so callers need not care which
// route served them, plus `ordered` for diagnostics.
export async function loadSharePage({ page, pageSize } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
  const current = Math.max(Number(page) || 1, 1);

  try {
    const [orderedCount, plainCount] = await Promise.all([
      kvZcard(SHARE_BY_CREATED_KEY),
      kvSmembers(SHARE_INDEX_KEY).then((m) => m.length),
    ]);

    // Short or empty ordered index means it has not been (fully) backfilled;
    // serving from it would silently hide shares.
    if (orderedCount === 0 || orderedCount < plainCount) {
      return { ...(await fullPage({ page: current, pageSize: size })), ordered: false };
    }

    const pageCount = Math.max(1, Math.ceil(orderedCount / size));
    const clamped = Math.min(current, pageCount);
    const start = (clamped - 1) * size;

    const tokens = await kvZrangeRev(SHARE_BY_CREATED_KEY, start, start + size - 1);
    const records = await Promise.all(tokens.map((t) => kvGet(`bunnyshare:${t}`)));

    return {
      rows: records.filter(Boolean),
      page: clamped,
      pageSize: size,
      pageCount,
      total: orderedCount,
      ordered: true,
    };
  } catch (err) {
    console.error("ordered share index unavailable, falling back to full read:", err);
    return { ...(await fullPage({ page: current, pageSize: size })), ordered: false };
  }
}

async function fullPage({ page, pageSize }) {
  return paginate(await loadAllShares(), { page, pageSize });
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
