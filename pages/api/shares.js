import { baseUrl } from "../../lib/shares";
import { bundleLinksForTokens } from "../../lib/bundles";
import { loadAllShares, filterShares, paginate } from "../../lib/shareQuery";
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

    const all = await loadAllShares();
    const filtered = filterShares(all, { status, q });
    const pageResult = paginate(filtered, { page, pageSize });

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
      totalAll: all.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
