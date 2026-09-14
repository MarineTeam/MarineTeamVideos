import { baseUrl } from "../../lib/shares";
import { bundleLinksForTokens } from "../../lib/bundles";
import { loadAllShares, loadSharePage, filterShares, paginate } from "../../lib/shareQuery";
import { withApiMonitor } from "../../lib/withMonitor";

// Admin shares listing. Accepts optional `status`, `q`, `page` and `pageSize`
// query params (see lib/shareQuery.js). A caller that passes NONE of them
// still gets a `shares` array, exactly as before this feature — just capped
// at the default page size, with the total and page count alongside it so
// the admin page can offer navigation. Filtering and ordering happen
// server-side so the browser never receives, sorts, or renders thousands of
// rows it isn't showing.
async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();
  try {
    const { status, q, page, pageSize } = req.query;
    const filtering = Boolean((status && status !== "all") || (q && q.trim()));

    // Unfiltered is the view that loads on every admin page open, so it gets
    // the bounded read: one ranked range against the createdAt-ordered index
    // plus one GET per row shown. Filtering still reads everything, because
    // status is derived and search is a substring match — see the cost note
    // in lib/shareQuery.js. `totalAll` therefore costs nothing extra when
    // filtering (we already have every record) and one ZCARD when not.
    let pageResult;
    let totalAll;
    if (filtering) {
      const all = await loadAllShares();
      pageResult = paginate(filterShares(all, { status, q }), { page, pageSize });
      totalAll = all.length;
    } else {
      pageResult = await loadSharePage({ page, pageSize });
      totalAll = pageResult.total;
    }

    const siteUrl = baseUrl(req);
    // Bundle links are resolved for the CURRENT PAGE only — one scan of the
    // bundle index either way, but no per-row work for rows nobody is
    // looking at.
    const bundleLinks = await bundleLinksForTokens(
      pageResult.rows.map((s) => s.token),
      siteUrl
    );
    const shares = pageResult.rows.map((s) =>
      bundleLinks[s.token] ? { ...s, bundleLink: bundleLinks[s.token] } : s
    );

    res.status(200).json({
      shares,
      total: pageResult.total,
      page: pageResult.page,
      pageSize: pageResult.pageSize,
      pageCount: pageResult.pageCount,
      // Unfiltered grand total, so the UI can say "12 of 340" without a
      // second round trip.
      totalAll,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
