import crypto from "crypto";
import { kvGet, kvSet, kvDel, kvSadd, kvSrem, kvSmembers } from "./kv";
import { normalizeEmail } from "./gate";

// Named, admin-editable lists of viewer emails ("Team A", "Reviewers", ...) —
// a labelled alternative to pasting the same emails into Bulk Share or the
// per-video Private list every time. A group is just a list of emails: it
// grants no access by itself. Resolving a group into recipients (see
// resolveGroupEmails below) is the only thing callers do with it — the
// actual access grant still goes through the normal bunnyshare:<token>
// machinery (lib/shares.js), same as typing the emails by hand would.
export const GROUP_INDEX_KEY = "bunnygroup-index";

export function groupKey(groupId) {
  return `bunnygroup:${groupId}`;
}

export async function listGroups() {
  const ids = await kvSmembers(GROUP_INDEX_KEY);
  const groups = await Promise.all(ids.map((id) => kvGet(groupKey(id))));
  return groups
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getGroup(groupId) {
  return kvGet(groupKey(groupId));
}

function normalizeEmails(list) {
  const flat = (Array.isArray(list) ? list : [list]).flatMap((e) =>
    String(e || "").split(/[,;\s]+/)
  );
  return [...new Set(flat.map((e) => normalizeEmail(e)).filter((e) => e.includes("@")))];
}

export async function createGroup({ name, emails }) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) throw new Error("Group name is required");

  const id = crypto.randomBytes(8).toString("hex");
  const record = {
    id,
    name: trimmedName,
    emails: normalizeEmails(emails),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await kvSet(groupKey(id), record);
  try {
    await kvSadd(GROUP_INDEX_KEY, id);
  } catch (err) {
    console.error("Failed to index new group (non-fatal):", err);
  }
  return record;
}

// Replaces name/emails on an existing group. Either field left undefined is
// preserved as-is, so e.g. renaming a group never touches its membership.
export async function updateGroup(groupId, { name, emails } = {}) {
  const record = await getGroup(groupId);
  if (!record) throw new Error("Group not found");

  const next = {
    ...record,
    name: name === undefined ? record.name : String(name).trim() || record.name,
    emails: emails === undefined ? record.emails : normalizeEmails(emails),
    updatedAt: Date.now(),
  };
  await kvSet(groupKey(groupId), next);
  return next;
}

export async function deleteGroup(groupId) {
  await kvDel(groupKey(groupId));
  try {
    await kvSrem(GROUP_INDEX_KEY, groupId);
  } catch (err) {
    console.error("Failed to unindex deleted group (non-fatal):", err);
  }
}

// Turns a mix of group ids and raw emails into one deduped recipient list —
// the single place bulk-share/invite call to fold "share with Team A" and
// "share with these two extra people" into one flat list of emails.
export async function resolveGroupEmails(groupIds = []) {
  const groups = await Promise.all(groupIds.filter(Boolean).map((id) => getGroup(id)));
  return normalizeEmails(groups.filter(Boolean).flatMap((g) => g.emails));
}
