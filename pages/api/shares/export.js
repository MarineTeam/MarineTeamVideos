import { loadAllShares, filterShares, shareStatus } from "../../../lib/shareQuery";
import { csvDocument } from "../../../lib/csv";
import { withApiMonitor } from "../../../lib/withMonitor";

// Admin-only CSV export of the shares table plus its per-share tracking.
// Sits under /api/shares/, which the middleware matcher covers like every
// other non-watch/non-bundle API route — no matcher change needed, and it
// 401s without admin credentials exactly as /api/shares does.
//
// Honours the same `status` and `q` filters as the listing (lib/shareQuery.js)
// so "export what I'm looking at" does what it says, but is deliberately NOT
// paginated: an export is the one place you want every matching row.
function isoOrBlank(ms) {
  return ms ? new Date(ms).toISOString() : "";
}

const HEADERS = [
  "token",
  "video_title",
  "video_id",
  "recipient_email",
  "status",
  "created_at",
  "expires_at",
  "max_views",
  "view_count",
  "first_viewed_at",
  "last_viewed_at",
  "play_count",
  "first_played_at",
  "last_played_at",
  "max_progress_pct",
  "completed_at",
  "email_failed",
  "source",
  "note",
];

async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();
  try {
    const { status, q } = req.query;
    const rows = filterShares(await loadAllShares(), { status, q });

    const body = csvDocument([
      HEADERS,
      ...rows.map((s) => [
        s.token,
        s.videoTitle,
        s.videoId,
        s.email,
        shareStatus(s),
        isoOrBlank(s.createdAt),
        isoOrBlank(s.expiresAt),
        s.maxViews || "",
        s.viewCount || 0,
        isoOrBlank(s.firstViewedAt),
        isoOrBlank(s.lastViewedAt),
        s.playCount || 0,
        isoOrBlank(s.firstPlayedAt),
        isoOrBlank(s.lastPlayedAt),
        s.maxProgressPct || 0,
        isoOrBlank(s.completedAt),
        s.emailFailed ? "yes" : "",
        s.source || "share",
        s.note || "",
      ]),
    ]);

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="shares-${stamp}.csv"`);
    // UTF-8 BOM so Excel reads non-ASCII titles correctly instead of
    // mojibake — harmless everywhere else.
    res.status(200).send(`﻿${body}`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
