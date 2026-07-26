import { listGroups, createGroup } from "../../lib/groups";

// Admin-only (default middleware matcher). GET lists all viewer groups;
// POST creates a new one.
export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const groups = await listGroups();
      return res.status(200).json({ groups });
    }

    if (req.method === "POST") {
      const { name, emails } = req.body || {};
      const group = await createGroup({ name, emails });
      return res.status(200).json({ ok: true, group });
    }

    res.status(405).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
