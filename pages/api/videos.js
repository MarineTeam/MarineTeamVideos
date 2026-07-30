import { listVideos, listCollections } from "../../lib/bunny";
import { withApiMonitor } from "../../lib/withMonitor";

async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();
  try {
    // Videos are the load-bearing part of this response — if collections
    // fails for any reason, still return videos rather than 500ing the
    // whole admin grid over what's ultimately a grouping label.
    const [videos, collections] = await Promise.all([
      listVideos(),
      listCollections().catch((err) => {
        console.error("Failed to list collections (non-fatal):", err);
        return [];
      }),
    ]);
    res.status(200).json({ videos, collections });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
