import { getGroup, updateGroup, deleteGroup } from "../../../lib/groups";
import { withApiMonitor } from "../../../lib/withMonitor";

// Admin-only (default middleware matcher). GET one group; PUT updates
// name/emails; DELETE removes it. Deleting a group only removes the label —
// it never touches any share/invite already created from its members.
async function handler(req, res) {
  const { groupId } = req.query;

  try {
    if (req.method === "GET") {
      const group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: "Group not found" });
      return res.status(200).json({ group });
    }

    if (req.method === "PUT") {
      const { name, emails } = req.body || {};
      const group = await updateGroup(groupId, { name, emails });
      return res.status(200).json({ ok: true, group });
    }

    if (req.method === "DELETE") {
      await deleteGroup(groupId);
      return res.status(200).json({ ok: true });
    }

    res.status(405).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
