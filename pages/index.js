import { useEffect, useState } from "react";

export default function Admin() {
  const [videos, setVideos] = useState([]);
  const [collections, setCollections] = useState([]);
  const [shares, setShares] = useState([]);
  const [loading, setLoading] = useState(true);
  const [shareForVideo, setShareForVideo] = useState(null);
  const [email, setEmail] = useState("");
  const [hours, setHours] = useState(72);
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [bulkEmail, setBulkEmail] = useState("");
  const [bulkHours, setBulkHours] = useState(72);
  const [bulkSending, setBulkSending] = useState(false);
  const [selectedShares, setSelectedShares] = useState(() => new Set());
  const [resendingBulk, setResendingBulk] = useState(false);
  const [extendingBulk, setExtendingBulk] = useState(false);
  const [revokingBulk, setRevokingBulk] = useState(false);
  // Per-share watermark override chosen in the share forms: "default" (inherit
  // the global setting), "on" (always), or "off" (never).
  const [watermark, setWatermark] = useState("default");
  const [bulkWatermark, setBulkWatermark] = useState("default");
  // Global watermark settings (edited in the Settings panel below).
  const [wmDefault, setWmDefault] = useState(false);
  const [wmEmails, setWmEmails] = useState("");
  const [wmDomains, setWmDomains] = useState("");
  // Per-video watermark overrides, keyed by video id -> boolean.
  const [wmByVideo, setWmByVideo] = useState({});
  // Recipient-facing geo whitelist: the country list is read-only here
  // (sourced from the GEO_WHITELIST env var, not editable in this UI); only
  // the enforcement toggle is saved from here.
  const [geoEnabled, setGeoEnabled] = useState(false);
  const [geoCountries, setGeoCountries] = useState([]);
  // Admin-surface geo whitelist: same pattern, sourced from ADMIN_GEO_WHITELIST.
  const [adminGeoEnabled, setAdminGeoEnabled] = useState(false);
  const [adminGeoCountries, setAdminGeoCountries] = useState([]);
  // Read-only, sourced from ADMIN_GEO_BYPASS_EMAILS — usernames that always
  // skip the admin geo check, regardless of country or the toggle above.
  const [adminGeoBypassEmails, setAdminGeoBypassEmails] = useState([]);
  const [savingSettings, setSavingSettings] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);
  // Private access list (YouTube-style "invite list") for one video: a
  // persistent, editable membership on top of the existing Share/Bulk Share
  // flows — see lib/invites.js. Adding an email that's already on the list
  // is a no-op; removing revokes that person's link immediately.
  const [inviteForVideo, setInviteForVideo] = useState(null);
  const [inviteList, setInviteList] = useState(null);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteHours, setInviteHours] = useState(8760);
  const [inviteWatermark, setInviteWatermark] = useState("default");
  const [inviteNotify, setInviteNotify] = useState(true);
  const [inviteSaving, setInviteSaving] = useState(false);
  // Named viewer groups (lib/groups.js) — a labelled list of emails an admin
  // can pick instead of retyping the same recipients into Bulk Share or a
  // video's Private list every time.
  const [groups, setGroups] = useState([]);
  const [showGroups, setShowGroups] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupEmails, setNewGroupEmails] = useState("");
  const [groupSaving, setGroupSaving] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [editingGroupEmails, setEditingGroupEmails] = useState("");
  const [bulkGroupPick, setBulkGroupPick] = useState("");
  const [inviteGroupPick, setInviteGroupPick] = useState("");

  function toggleSelected(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleShareSelected(token) {
    setSelectedShares((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    });
  }

  async function loadAll() {
    setLoading(true);
    const [vRes, sRes, setRes, gRes] = await Promise.all([
      fetch("/api/videos").then((r) => r.json()),
      fetch("/api/shares").then((r) => r.json()),
      fetch("/api/settings").then((r) => r.json()).catch(() => ({})),
      fetch("/api/groups").then((r) => r.json()).catch(() => ({})),
    ]);
    setVideos(vRes.videos || []);
    setCollections(vRes.collections || []);
    setShares(sRes.shares || []);
    if (setRes && setRes.settings) applySettings(setRes.settings);
    setGroups((gRes && gRes.groups) || []);
    setLoading(false);
  }

  // Adds every video in a Bunny collection to the current selection, so
  // "share this whole collection" is just a shortcut into the same
  // Bulk Share bar/flow used for a hand-picked set of videos.
  function selectCollection(collectionId) {
    setSelected((prev) => {
      const next = new Set(prev);
      videos.filter((v) => v.collectionId === collectionId).forEach((v) => next.add(v.id));
      return next;
    });
  }

  async function createGroup() {
    if (!newGroupName.trim() || !newGroupEmails.trim()) return;
    setGroupSaving(true);
    const res = await fetch("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newGroupName, emails: newGroupEmails }),
    });
    const data = await res.json();
    setGroupSaving(false);
    if (data.ok) {
      setGroups((prev) => [...prev, data.group].sort((a, b) => a.name.localeCompare(b.name)));
      setNewGroupName("");
      setNewGroupEmails("");
      setMessage(`Created group "${data.group.name}"`);
    } else {
      setMessage(`Error: ${data.error}`);
    }
  }

  function startEditGroup(group) {
    setEditingGroupId(group.id);
    setEditingGroupEmails(group.emails.join(", "));
  }

  async function saveEditGroup(groupId) {
    const res = await fetch(`/api/groups/${groupId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails: editingGroupEmails }),
    });
    const data = await res.json();
    if (data.ok) {
      setGroups((prev) => prev.map((g) => (g.id === groupId ? data.group : g)));
      setEditingGroupId(null);
      setMessage(`Updated group "${data.group.name}"`);
    } else {
      setMessage(`Error: ${data.error}`);
    }
  }

  async function removeGroup(group) {
    if (!confirm(`Delete group "${group.name}"? This only removes the label — it doesn't revoke any links already shared with its members.`)) return;
    const res = await fetch(`/api/groups/${group.id}`, { method: "DELETE" });
    const data = await res.json();
    if (data.ok) {
      setGroups((prev) => prev.filter((g) => g.id !== group.id));
      setMessage(`Deleted group "${group.name}"`);
    } else {
      setMessage(`Error: ${data.error}`);
    }
  }

  // Appends a group's emails into an existing comma-separated recipient
  // string without duplicating anyone already typed in.
  function mergeGroupIntoEmails(current, groupId) {
    const group = groups.find((g) => g.id === groupId);
    if (!group) return current;
    const existing = new Set(
      current.split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)
    );
    const toAdd = group.emails.filter((e) => !existing.has(e.toLowerCase()));
    if (toAdd.length === 0) return current;
    return current ? `${current}, ${toAdd.join(", ")}` : toAdd.join(", ");
  }

  function applySettings(s) {
    setWmDefault(!!s.watermarkDefault);
    setWmEmails((s.watermarkExemptEmails || []).join(", "));
    setWmDomains((s.watermarkExemptDomains || []).join(", "));
    setWmByVideo(s.watermarkByVideo || {});
    setGeoEnabled(!!s.geoWhitelistEnabled);
    setGeoCountries(s.geoWhitelistCountries || []);
    setAdminGeoEnabled(!!s.adminGeoWhitelistEnabled);
    setAdminGeoCountries(s.adminGeoWhitelistCountries || []);
    setAdminGeoBypassEmails(s.adminGeoBypassEmails || []);
  }

  // Current per-video override as a select value: "on" / "off" / "default".
  function videoWmChoice(videoId) {
    const v = wmByVideo[videoId];
    return v === true ? "on" : v === false ? "off" : "default";
  }

  async function setVideoWatermark(videoId, choice) {
    setMessage("Updating watermark...");
    const res = await fetch("/api/video-watermark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId, choice }),
    });
    const data = await res.json();
    if (data.ok) {
      setWmByVideo(data.settings.watermarkByVideo || {});
      setMessage("Watermark updated");
    } else {
      setMessage(`Error: ${data.error}`);
    }
  }

  // "default" → omit the field (JSON.stringify drops undefined) so the share
  // inherits the global setting; "on"/"off" → an explicit per-share override.
  function wmValue(sel) {
    return sel === "on" ? true : sel === "off" ? false : undefined;
  }

  async function saveSettings() {
    setSavingSettings(true);
    setMessage("Saving settings...");
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        watermarkDefault: wmDefault,
        watermarkExemptEmails: wmEmails,
        watermarkExemptDomains: wmDomains,
        geoWhitelistEnabled: geoEnabled,
        adminGeoWhitelistEnabled: adminGeoEnabled,
      }),
    });
    const data = await res.json();
    setSavingSettings(false);
    if (data.ok) {
      applySettings(data.settings);
      setMessage("Settings saved");
    } else {
      setMessage(`Error: ${data.error}`);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function submitShare(video) {
    setMessage("Sending...");
    const res = await fetch("/api/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: video.id,
        videoTitle: video.title,
        email,
        hours,
        watermark: wmValue(watermark),
      }),
    });
    const data = await res.json();
    if (data.ok) {
      let msg = `Sent to ${email}`;
      const bundleLines = data.links
        .filter((l) => l.bundleLink)
        .map((l) => `${l.email}: ${l.bundleLink}`)
        .join(" | ");
      if (bundleLines) msg += ` — Bundle page: ${bundleLines}`;
      if (data.failures) {
        msg += ` — FAILED for ${data.failures.map((f) => f.email).join(", ")} (link created, email not sent — see Resend in the table below)`;
      }
      setMessage(msg);
      setShareForVideo(null);
      setEmail("");
      setWatermark("default");
      loadAll();
    } else {
      setMessage(`Error: ${data.error}`);
    }
  }

  async function submitBulk() {
    const chosen = videos.filter((v) => selected.has(v.id));
    const emails = bulkEmail.split(/[,;\s]+/).map((e) => e.trim()).filter((e) => e.includes("@"));
    if (chosen.length === 0 || emails.length === 0) return;
    setBulkSending(true);
    setMessage("Sending...");
    const res = await fetch("/api/share-bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videos: chosen.map((v) => ({ id: v.id, title: v.title })),
        emails,
        hours: bulkHours,
        watermark: wmValue(bulkWatermark),
      }),
    });
    const data = await res.json();
    setBulkSending(false);
    if (data.ok) {
      const sentTo = data.recipients.map((r) => r.email).join(", ");
      let msg = `Created ${data.count} separate link${data.count !== 1 ? "s" : ""}; emailed ${sentTo}`;
      const bundleLines = data.recipients
        .filter((r) => r.bundleLink)
        .map((r) => `${r.email}: ${r.bundleLink}`)
        .join(" | ");
      if (bundleLines) msg += ` — Bundle pages: ${bundleLines}`;
      if (data.failures) {
        msg += ` — FAILED for ${data.failures.map((f) => f.email).join(", ")} (links created, email not sent — see Resend in the table below)`;
      }
      setMessage(msg);
      setSelected(new Set());
      setBulkEmail("");
      loadAll();
    } else {
      setMessage(`Error: ${data.error}`);
    }
  }

  async function openInvite(video) {
    setInviteForVideo(video);
    setInviteEmail("");
    setInviteList(null);
    setInviteLoading(true);
    const res = await fetch(`/api/video-invite?videoId=${encodeURIComponent(video.id)}`);
    const data = await res.json();
    setInviteList(data.invite || { videoId: video.id, videoTitle: video.title, members: [] });
    setInviteLoading(false);
  }

  function closeInvite() {
    setInviteForVideo(null);
    setInviteList(null);
  }

  async function submitInvite() {
    if (!inviteForVideo) return;
    setInviteSaving(true);
    setMessage("Updating invite list...");
    const res = await fetch("/api/video-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: inviteForVideo.id,
        videoTitle: inviteForVideo.title,
        emails: inviteEmail,
        hours: inviteHours,
        watermark: wmValue(inviteWatermark),
        notify: inviteNotify,
      }),
    });
    const data = await res.json();
    setInviteSaving(false);
    if (data.ok) {
      let msg =
        data.added.length > 0
          ? inviteNotify
            ? `Invited ${data.added.map((a) => a.email).join(", ")}`
            : `Added ${data.added.map((a) => a.email).join(", ")} (no email sent)`
          : "No new emails to invite";
      if (data.alreadyInvited.length > 0) {
        msg += ` — already on the list: ${data.alreadyInvited.join(", ")}`;
      }
      if (data.failures) {
        msg += ` — FAILED to email ${data.failures.map((f) => f.email).join(", ")} (access granted, email not sent)`;
      }
      setMessage(msg);
      setInviteList(data.invite);
      setInviteEmail("");
      loadAll();
    } else {
      setMessage(`Error: ${data.error}`);
    }
  }

  async function removeInvitee(email) {
    if (!inviteForVideo) return;
    if (!confirm(`Remove ${email} from the private access list? Their link will be revoked immediately.`)) return;
    setMessage("Removing...");
    const res = await fetch("/api/video-invite/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId: inviteForVideo.id, email }),
    });
    const data = await res.json();
    if (data.ok) {
      setMessage(`Removed ${email}`);
      setInviteList((prev) => prev && { ...prev, members: prev.members.filter((m) => m.email !== email) });
      loadAll();
    } else {
      setMessage(`Error: ${data.error}`);
    }
  }

  async function cleanup() {
    if (!confirm("Delete all expired and revoked links from the database?")) return;
    setMessage("Cleaning up...");
    const res = await fetch("/api/cleanup", { method: "POST" });
    const data = await res.json();
    if (data.deleted !== undefined) {
      setMessage(`Removed ${data.deleted} stale link${data.deleted !== 1 ? "s" : ""}`);
      loadAll();
    } else {
      setMessage(`Error: ${data.error}`);
    }
  }

  // One-time (idempotent, safe to re-run) migration: populates the share/
  // bundle index sets from a full scan, so records that existed before the
  // index did still show up in this table. Normally a no-op once run.
  async function backfillIndex() {
    if (!confirm("Rebuild the share/bundle index from a full scan? Only needed once, or if the list ever looks incomplete.")) return;
    setMessage("Rebuilding index...");
    const res = await fetch("/api/backfill-index", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      setMessage(`Indexed ${data.indexedShares} share${data.indexedShares !== 1 ? "s" : ""} and ${data.indexedBundles} bundle${data.indexedBundles !== 1 ? "s" : ""}`);
      loadAll();
    } else {
      setMessage(`Error: ${data.error}`);
    }
  }

  async function revoke(token) {
    if (!confirm("Revoke this access link?")) return;
    await fetch("/api/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    loadAll();
  }

  async function unrevoke(token) {
    if (!confirm("Restore this revoked link?")) return;
    setMessage("Restoring...");
    const res = await fetch("/api/unrevoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const data = await res.json();
    setMessage(data.ok ? "Link restored" : `Error: ${data.error}`);
    loadAll();
  }

  async function deletePermanently(token) {
    if (!confirm("Permanently delete this revoked link? This cannot be undone — Restore will no longer be possible.")) return;
    setMessage("Deleting...");
    const res = await fetch("/api/revoke-permanent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const data = await res.json();
    setMessage(data.ok ? "Link permanently deleted" : `Error: ${data.error}`);
    loadAll();
  }

  async function resend(token) {
    setMessage("Resending...");
    const res = await fetch("/api/share/resend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const data = await res.json();
    setMessage(data.ok ? "Email sent" : `Error: ${data.error}`);
    loadAll();
  }

  async function resendSelected() {
    const tokens = [...selectedShares];
    if (tokens.length === 0) return;
    setResendingBulk(true);
    setMessage(`Resending ${tokens.length} link${tokens.length !== 1 ? "s" : ""}...`);
    const res = await fetch("/api/share/resend-bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens }),
    });
    const data = await res.json();
    setResendingBulk(false);
    if (data.ok) {
      let msg = `Resent ${data.succeeded.length} of ${tokens.length}`;
      if (data.failures.length > 0) {
        msg += ` — FAILED for ${data.failures.length}: ${data.failures.map((f) => f.error).join("; ")}`;
      }
      setMessage(msg);
      setSelectedShares(new Set());
      loadAll();
    } else {
      setMessage(`Error: ${data.error}`);
    }
  }

  async function extend(token) {
    const hoursInput = prompt("Extend by how many hours?", "24");
    if (!hoursInput) return;
    setMessage("Extending...");
    const res = await fetch("/api/share/extend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, hours: Number(hoursInput) }),
    });
    const data = await res.json();
    setMessage(data.ok ? `Extended to ${new Date(data.expiresAt).toLocaleString()}` : `Error: ${data.error}`);
    loadAll();
  }

  async function extendSelected() {
    const tokens = [...selectedShares];
    if (tokens.length === 0) return;
    const hoursInput = prompt(`Extend ${tokens.length} link${tokens.length !== 1 ? "s" : ""} by how many hours?`, "24");
    if (!hoursInput) return;
    setExtendingBulk(true);
    setMessage(`Extending ${tokens.length} link${tokens.length !== 1 ? "s" : ""}...`);
    const res = await fetch("/api/share/extend-bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens, hours: Number(hoursInput) }),
    });
    const data = await res.json();
    setExtendingBulk(false);
    if (data.ok) {
      let msg = `Extended ${data.succeeded.length} of ${tokens.length}`;
      if (data.failures.length > 0) {
        msg += ` — FAILED for ${data.failures.length}: ${data.failures.map((f) => f.error).join("; ")}`;
      }
      setMessage(msg);
      setSelectedShares(new Set());
      loadAll();
    } else {
      setMessage(`Error: ${data.error}`);
    }
  }

  async function revokeSelected() {
    const tokens = [...selectedShares];
    if (tokens.length === 0) return;
    if (!confirm(`Revoke ${tokens.length} access link${tokens.length !== 1 ? "s" : ""}?`)) return;
    setRevokingBulk(true);
    setMessage(`Revoking ${tokens.length} link${tokens.length !== 1 ? "s" : ""}...`);
    const res = await fetch("/api/revoke-bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens }),
    });
    const data = await res.json();
    setRevokingBulk(false);
    if (data.ok) {
      let msg = `Revoked ${data.succeeded.length} of ${tokens.length}`;
      if (data.failures.length > 0) {
        msg += ` — FAILED for ${data.failures.length}: ${data.failures.map((f) => f.error).join("; ")}`;
      }
      setMessage(msg);
      setSelectedShares(new Set());
      loadAll();
    } else {
      setMessage(`Error: ${data.error}`);
    }
  }

  function statusOf(s) {
    if (s.revoked) return "Revoked";
    if (Date.now() > s.expiresAt) return "Expired";
    return "Active";
  }

  if (loading) return <p style={{ padding: 20 }}>Loading...</p>;

  const analytics = computeAnalytics(shares);

  return (
    <div style={styles.wrap}>
      <header style={styles.header}>
        <h1 style={styles.h1}>Video Library</h1>
        <p style={styles.subtitle}>Share videos privately and manage active links</p>
      </header>
      {message && <p style={styles.message}>{message}</p>}

      <div style={styles.panelToggles}>
        <button onClick={() => setShowSettings((v) => !v)} className="btn btn-secondary">
          {showSettings ? "Hide settings" : "⚙ Settings"}
        </button>
        <button onClick={() => setShowAnalytics((v) => !v)} className="btn btn-secondary">
          {showAnalytics ? "Hide analytics" : "📊 Analytics"}
        </button>
        <button onClick={() => setShowGroups((v) => !v)} className="btn btn-secondary">
          {showGroups ? "Hide groups" : "👥 Viewer groups"}
        </button>
      </div>

      {showGroups && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Viewer groups</h3>
          <p style={styles.hint}>
            Named lists of emails (e.g. "Team A") you can pick from Bulk Share
            or a video's Private list instead of retyping recipients. A group
            grants no access by itself — it only fills in emails.
          </p>

          {groups.length === 0 && <p style={{ opacity: 0.7 }}>No groups yet.</p>}
          {groups.map((g) => (
            <div key={g.id} style={styles.inviteRow}>
              {editingGroupId === g.id ? (
                <>
                  <input
                    type="text"
                    value={editingGroupEmails}
                    onChange={(e) => setEditingGroupEmails(e.target.value)}
                    className="input"
                    style={{ flex: 1 }}
                  />
                  <button onClick={() => saveEditGroup(g.id)} className="btn btn-primary" style={styles.rowBtn}>
                    Save
                  </button>
                  <button onClick={() => setEditingGroupId(null)} className="btn btn-secondary" style={styles.rowBtn}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <span>
                    <strong>{g.name}</strong> — {g.emails.length} viewer{g.emails.length !== 1 ? "s" : ""}
                    <span style={{ opacity: 0.7 }}>{g.emails.length > 0 ? `: ${g.emails.join(", ")}` : ""}</span>
                  </span>
                  <button onClick={() => startEditGroup(g)} className="btn btn-secondary" style={styles.rowBtn}>
                    Edit
                  </button>
                  <button onClick={() => removeGroup(g)} className="btn btn-danger" style={styles.rowBtn}>
                    Delete
                  </button>
                </>
              )}
            </div>
          ))}

          <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              type="text"
              placeholder="group name, e.g. Team A"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              className="input"
              style={{ flex: "1 1 160px" }}
            />
            <input
              type="text"
              placeholder="emails, comma or space separated"
              value={newGroupEmails}
              onChange={(e) => setNewGroupEmails(e.target.value)}
              className="input"
              style={{ flex: "2 1 260px" }}
            />
            <button
              onClick={createGroup}
              disabled={groupSaving || !newGroupName.trim() || !newGroupEmails.trim()}
              className="btn btn-primary"
            >
              {groupSaving ? "Creating..." : "Create group"}
            </button>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Watermark settings</h3>
          <label style={{ display: "block", marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={wmDefault}
              onChange={(e) => setWmDefault(e.target.checked)}
            />{" "}
            Watermark the viewer's email over every player by default
          </label>
          <label style={styles.settingLabel}>
            Exempt emails — never watermarked (comma/space separated)
            <textarea
              value={wmEmails}
              onChange={(e) => setWmEmails(e.target.value)}
              placeholder="admin@you.com, reviewer@you.com"
              style={styles.textarea}
            />
          </label>
          <label style={styles.settingLabel}>
            Exempt domains — never watermarked (e.g. your internal domain)
            <textarea
              value={wmDomains}
              onChange={(e) => setWmDomains(e.target.value)}
              placeholder="yourcompany.com"
              style={styles.textarea}
            />
          </label>
          <p style={styles.hint}>
            Resolution order (most specific wins): an exempt viewer is never
            watermarked; otherwise a share's own Always/Never (Share form) wins;
            otherwise the video's own Always/Never (select on each Videos row);
            otherwise this global default. Note: the watermark is a client-side
            overlay for leak attribution, not burned into the video — it deters
            casual re-sharing, it isn't DRM.
          </p>

          <h3>Geo location whitelist</h3>
          <p style={styles.hint}>
            Restricts every /watch and /bundle page. The country list itself
            is <strong>not</strong> editable here — it's set via the{" "}
            <code>GEO_WHITELIST</code> environment variable in your hosting
            provider's dashboard, on purpose: it keeps the list out of reach
            of a mistyped Settings save, and consistent with the admin
            whitelist below.
            {geoCountries.length > 0 ? (
              <> Currently configured: <strong>{geoCountries.join(", ")}</strong>.</>
            ) : (
              <> Not currently configured — this toggle has no effect until <code>GEO_WHITELIST</code> is set.</>
            )}
            {" "}Detected from Vercel's edge network (<code>x-vercel-ip-country</code>)
            — a coarse IP-geolocation signal, not identity verification (a VPN
            defeats it), and inert on non-Vercel deployments or local dev (no
            header means access is allowed, never silently blocked).
          </p>
          <label style={{ display: "block", marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={geoEnabled}
              onChange={(e) => setGeoEnabled(e.target.checked)}
            />{" "}
            Enforce the geo whitelist
          </label>

          <h3>Admin access geo whitelist</h3>
          <p style={styles.hint}>
            Restricts this admin page and its API routes too (on top of your
            login credentials). The country list itself is{" "}
            <strong>not</strong> editable here — it's set via the{" "}
            <code>ADMIN_GEO_WHITELIST</code> environment variable in your
            hosting provider's dashboard, on purpose: if enabling this ever
            locks you out, recovery can't depend on reaching this page.
            {adminGeoCountries.length > 0 ? (
              <> Currently configured: <strong>{adminGeoCountries.join(", ")}</strong>.</>
            ) : (
              <> Not currently configured — this toggle has no effect until <code>ADMIN_GEO_WHITELIST</code> is set.</>
            )}
          </p>
          <label style={{ display: "block", marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={adminGeoEnabled}
              onChange={(e) => setAdminGeoEnabled(e.target.checked)}
            />{" "}
            Enforce the admin geo whitelist
          </label>
          <p style={styles.hint}>
            Standing bypass: a Basic Auth username listed in the{" "}
            <code>ADMIN_GEO_BYPASS_EMAILS</code> environment variable always
            skips this check, regardless of country or the toggle above.
            Also env-var-only, not editable here — arm it{" "}
            <strong>before</strong> traveling, since env var changes need a
            redeploy and this is a standing safety net, not an
            in-the-moment fix.
            {adminGeoBypassEmails.length > 0 ? (
              <> Currently configured: <strong>{adminGeoBypassEmails.join(", ")}</strong>.</>
            ) : (
              <> Not currently configured.</>
            )}
          </p>

          <button onClick={saveSettings} disabled={savingSettings} className="btn btn-primary">
            {savingSettings ? "Saving..." : "Save settings"}
          </button>
        </div>
      )}

      {showAnalytics && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Per-video analytics</h3>
          {analytics.length === 0 ? (
            <p style={styles.hint}>No shares yet.</p>
          ) : (
            <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={styles.thLeft}>Video</th>
                  <th>Shares</th>
                  <th>Recipients</th>
                  <th>Views</th>
                  <th>Started</th>
                  <th>Completed</th>
                  <th>Avg progress</th>
                </tr>
              </thead>
              <tbody>
                {analytics.map((a) => (
                  <tr key={a.videoId}>
                    <td>{a.title}</td>
                    <td style={styles.tdCenter}>{a.shares}</td>
                    <td style={styles.tdCenter}>{a.recipients}</td>
                    <td style={styles.tdCenter}>{a.views}</td>
                    <td style={styles.tdCenter}>{a.started}</td>
                    <td style={styles.tdCenter}>
                      {a.completed} ({a.completionRate}%)
                    </td>
                    <td style={styles.tdCenter}>{a.avgProgress ? `${a.avgProgress}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      )}

      {selected.size > 0 && (
        <div className="bulk-bar">
          <strong>{selected.size} selected</strong>
          <input
            type="text"
            placeholder="recipient emails, comma-separated"
            value={bulkEmail}
            onChange={(e) => setBulkEmail(e.target.value)}
            className="input"
            style={{ flex: "1 1 220px", width: "auto" }}
          />
          {groups.length > 0 && (
            <select
              value={bulkGroupPick}
              onChange={(e) => {
                setBulkEmail((prev) => mergeGroupIntoEmails(prev, e.target.value));
                setBulkGroupPick("");
              }}
            >
              <option value="">+ Add group...</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.emails.length})
                </option>
              ))}
            </select>
          )}
          <label style={{ whiteSpace: "nowrap" }}>
            Valid for (hrs):{" "}
            <input
              type="number"
              value={bulkHours}
              onChange={(e) => setBulkHours(e.target.value)}
              className="input"
              style={{ width: 70, display: "inline-block" }}
            />
          </label>
          <label style={{ whiteSpace: "nowrap" }}>
            Watermark:{" "}
            <select value={bulkWatermark} onChange={(e) => setBulkWatermark(e.target.value)}>
              <option value="default">Default</option>
              <option value="on">Always</option>
              <option value="off">Never</option>
            </select>
          </label>
          <button
            onClick={submitBulk}
            disabled={!bulkEmail || bulkSending}
            className="btn btn-primary"
          >
            {bulkSending ? "Sending..." : `Send ${selected.size} video${selected.size !== 1 ? "s" : ""} (separate links per recipient)`}
          </button>
          <button onClick={() => setSelected(new Set())} className="btn btn-secondary">
            Clear
          </button>
        </div>
      )}

      {collections.filter((c) => c.videoCount > 0).length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          {collections
            .filter((c) => c.videoCount > 0)
            .map((c) => (
              <button
                key={c.id}
                onClick={() => selectCollection(c.id)}
                className="btn btn-secondary"
                title={`Select all ${c.videoCount} video${c.videoCount !== 1 ? "s" : ""} in "${c.name}"`}
              >
                📁 {c.name} ({c.videoCount})
              </button>
            ))}
        </div>
      )}

      <div style={styles.grid}>
        {videos.map((v) => (
          <div key={v.id} className={`video-card${selected.has(v.id) ? " selected" : ""}`}>
            {v.thumbnail && <img src={v.thumbnail} alt={v.title} style={styles.thumb} />}
            <div style={{ padding: 12 }}>
              <label style={styles.selectLabel}>
                <input
                  type="checkbox"
                  checked={selected.has(v.id)}
                  onChange={() => toggleSelected(v.id)}
                />{" "}
                Select
              </label>
              <strong style={styles.cardTitle}>{v.title}</strong>
              <label style={styles.videoWmLabel}>
                Watermark:{" "}
                <select
                  value={videoWmChoice(v.id)}
                  onChange={(e) => setVideoWatermark(v.id, e.target.value)}
                >
                  <option value="default">Default</option>
                  <option value="on">Always</option>
                  <option value="off">Never</option>
                </select>
              </label>
              <div>
                <button onClick={() => setShareForVideo(v)} className="btn btn-primary" style={{ marginTop: 10 }}>
                  Share
                </button>{" "}
                <button onClick={() => openInvite(v)} className="btn btn-secondary" style={{ marginTop: 10 }}>
                  Private list
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {shareForVideo && (
        <div className="modal-overlay" onClick={() => setShareForVideo(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Share "{shareForVideo.title}"</h3>
            <input
              type="email"
              placeholder="recipient@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
              autoFocus
            />
            <div style={{ marginTop: 12 }}>
              <label style={styles.fieldLabel}>Link valid for (hours)</label>
              <input
                type="number"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                className="input"
                style={{ width: 100 }}
              />
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={styles.fieldLabel}>Watermark viewer's email</label>
              <select value={watermark} onChange={(e) => setWatermark(e.target.value)} style={{ width: "100%" }}>
                <option value="default">Default (global setting)</option>
                <option value="on">Always</option>
                <option value="off">Never</option>
              </select>
            </div>
            <div style={{ marginTop: 20, display: "flex", gap: 8 }}>
              <button onClick={() => submitShare(shareForVideo)} className="btn btn-primary">
                Send
              </button>
              <button onClick={() => setShareForVideo(null)} className="btn btn-secondary">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {inviteForVideo && (
        <div className="modal-overlay" onClick={closeInvite}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Private access to "{inviteForVideo.title}"</h3>
            <p style={styles.subtitle}>
              Invite people by email, like a private YouTube video. Adding someone already on the list
              doesn't re-send anything; removing someone revokes their link right away.
            </p>

            {inviteLoading ? (
              <p>Loading...</p>
            ) : (
              <div style={{ marginBottom: 16 }}>
                {(!inviteList || inviteList.members.length === 0) && (
                  <p style={{ opacity: 0.7 }}>Nobody has been invited yet.</p>
                )}
                {inviteList &&
                  inviteList.members.map((m) => (
                    <div key={m.email} style={styles.inviteRow}>
                      <span>{m.email}</span>
                      <span style={styles.inviteStatus}>
                        {m.revoked ? "Revoked" : m.expiresAt && Date.now() > m.expiresAt ? "Expired" : "Active"}
                        {m.emailFailed && " · email failed"}
                      </span>
                      <button onClick={() => removeInvitee(m.email)} className="btn btn-danger" style={styles.rowBtn}>
                        Remove
                      </button>
                    </div>
                  ))}
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                placeholder="add emails, comma or space separated"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="input"
                style={{ flex: 1 }}
              />
              {groups.length > 0 && (
                <select
                  value={inviteGroupPick}
                  onChange={(e) => {
                    setInviteEmail((prev) => mergeGroupIntoEmails(prev, e.target.value));
                    setInviteGroupPick("");
                  }}
                >
                  <option value="">+ Add group...</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} ({g.emails.length})
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={styles.fieldLabel}>Access valid for (hours)</label>
              <input
                type="number"
                value={inviteHours}
                onChange={(e) => setInviteHours(e.target.value)}
                className="input"
                style={{ width: 120 }}
              />
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={styles.fieldLabel}>Watermark new viewers' email</label>
              <select value={inviteWatermark} onChange={(e) => setInviteWatermark(e.target.value)} style={{ width: "100%" }}>
                <option value="default">Default (global setting)</option>
                <option value="on">Always</option>
                <option value="off">Never</option>
              </select>
            </div>
            <label style={{ ...styles.fieldLabel, marginTop: 12, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={inviteNotify}
                onChange={(e) => setInviteNotify(e.target.checked)}
              />{" "}
              Notify new people by email
            </label>
            <div style={{ marginTop: 20, display: "flex", gap: 8 }}>
              <button onClick={submitInvite} disabled={inviteSaving} className="btn btn-primary">
                {inviteSaving ? "Saving..." : "Add to list"}
              </button>
              <button onClick={closeInvite} className="btn btn-secondary">
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={styles.sectionHeader}>
        <h2 style={{ margin: 0 }}>Shared Links</h2>
        <button onClick={cleanup} className="btn btn-muted">
          🗑 Clean up expired &amp; revoked
        </button>
        <button onClick={backfillIndex} className="btn btn-muted" title="One-time migration: only needed once, or if the list ever looks incomplete">
          🔁 Rebuild index
        </button>
      </div>

      {selectedShares.size > 0 && (
        <div className="bulk-bar">
          <strong>{selectedShares.size} link{selectedShares.size !== 1 ? "s" : ""} selected</strong>
          <button onClick={resendSelected} disabled={resendingBulk} className="btn btn-primary">
            {resendingBulk ? "Resending..." : `Resend ${selectedShares.size}`}
          </button>
          <button onClick={extendSelected} disabled={extendingBulk} className="btn btn-primary">
            {extendingBulk ? "Extending..." : `Extend ${selectedShares.size}`}
          </button>
          <button onClick={revokeSelected} disabled={revokingBulk} className="btn btn-danger">
            {revokingBulk ? "Revoking..." : `Revoke ${selectedShares.size}`}
          </button>
          <button onClick={() => setSelectedShares(new Set())} className="btn btn-secondary">
            Clear
          </button>
        </div>
      )}

      <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th></th>
            <th>Video</th>
            <th>Email</th>
            <th>Source</th>
            <th>Link</th>
            <th>Status</th>
            <th>Views</th>
            <th>Watched</th>
            <th>Expires</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {shares.map((s) => {
            const active = statusOf(s) === "Active";
            const extendable = !s.revoked; // extend works on Active or Expired, just not Revoked
            return (
              <tr key={s.token}>
                <td>
                  {extendable && (
                    <input
                      type="checkbox"
                      checked={selectedShares.has(s.token)}
                      onChange={() => toggleShareSelected(s.token)}
                    />
                  )}
                </td>
                <td>
                  {s.videoTitle}
                  {s.watermark === true && (
                    <span style={styles.wmBadge} title="Watermark: always on for this share">
                      💧
                    </span>
                  )}
                  {s.watermark === false && (
                    <span style={styles.wmBadgeOff} title="Watermark: off for this share">
                      no-wm
                    </span>
                  )}
                </td>
                <td>{s.email}</td>
                <td>
                  {s.source === "invite" ? (
                    <span
                      className="status-pill"
                      style={{ background: "#e6f4ea", color: "#1a7f37" }}
                      title="Added via the Private list for this video"
                    >
                      Private list
                    </span>
                  ) : (
                    <span
                      className="status-pill"
                      style={{ background: "#eaeef2", color: "#57606a" }}
                      title="Created via Share / Bulk Share"
                    >
                      Share
                    </span>
                  )}
                </td>
                <td>
                  <a href={`/watch/${s.token}`} target="_blank" rel="noreferrer" style={{ fontSize: 13, wordBreak: "break-all" }}>
                    /watch/{s.token}
                  </a>
                  {s.bundleLink && (
                    <div>
                      <a href={s.bundleLink} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#57606a" }}>
                        bundle page
                      </a>
                    </div>
                  )}
                </td>
                <td>
                  <span className={`status-pill status-${statusOf(s).toLowerCase()}`}>{statusOf(s)}</span>
                  {s.emailFailed && (
                    <div style={styles.emailFailedBadge} title={s.emailError || "Email failed to send"}>
                      ⚠ email failed
                    </div>
                  )}
                </td>
                <td title={s.lastViewedAt ? `Last viewed ${new Date(s.lastViewedAt).toLocaleString()}` : "Never viewed"}>
                  {s.viewCount ? `${s.viewCount}×` : "—"}
                </td>
                <td title={s.lastPlayedAt ? `Last played ${new Date(s.lastPlayedAt).toLocaleString()}${s.playCount ? `, ${s.playCount} play${s.playCount !== 1 ? "s" : ""}` : ""}` : "Never played"}>
                  {s.completedAt ? "100% ✓" : s.maxProgressPct ? `${s.maxProgressPct}%` : s.playCount ? "started" : "—"}
                </td>
                <td>{new Date(s.expiresAt).toLocaleString()}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {active && (
                    <button onClick={() => resend(s.token)} className="btn btn-secondary" style={styles.rowBtn}>
                      Resend
                    </button>
                  )}
                  {extendable && (
                    <button onClick={() => extend(s.token)} className="btn btn-secondary" style={styles.rowBtn}>
                      Extend
                    </button>
                  )}
                  {active && (
                    <button onClick={() => revoke(s.token)} className="btn btn-danger" style={styles.rowBtn}>
                      Revoke
                    </button>
                  )}
                  {s.revoked && (
                    <button onClick={() => unrevoke(s.token)} className="btn btn-secondary" style={styles.rowBtn}>
                      Restore
                    </button>
                  )}
                  {s.revoked && (
                    <button onClick={() => deletePermanently(s.token)} className="btn btn-danger" style={styles.rowBtn}>
                      Delete permanently
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}

// Rolls the per-share tracking fields up per video for the Analytics panel.
// Reads only additive fields already present on records (viewCount, playCount,
// maxProgressPct, completedAt) — nothing new is stored for this.
function computeAnalytics(shares) {
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

const styles = {
  wrap: { maxWidth: 1100, margin: "0 auto", padding: "28px 20px 60px" },
  header: { marginBottom: 20 },
  h1: { margin: "0 0 4px", fontSize: 28 },
  subtitle: { margin: 0, color: "#57606a", fontSize: 14 },
  sectionHeader: { display: "flex", alignItems: "center", gap: 16, marginTop: 44, marginBottom: 16 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 16 },
  thumb: { width: "100%", height: 124, objectFit: "cover", display: "block", background: "#eee" },
  cardTitle: { display: "block", fontSize: 15, margin: "2px 0 6px" },
  message: { color: "#1f6feb", background: "#eef4ff", padding: "8px 12px", borderRadius: 6, fontSize: 14 },
  selectLabel: { display: "block", fontSize: 13, color: "#57606a", marginBottom: 4, cursor: "pointer" },
  videoWmLabel: { display: "block", fontSize: 12, color: "#57606a", margin: "6px 0" },
  emailFailedBadge: { fontSize: 12, color: "#d1242f" },
  panelToggles: { display: "flex", gap: 10, margin: "8px 0 20px" },
  settingLabel: { display: "block", fontSize: 14, color: "#24292f", marginBottom: 12 },
  fieldLabel: { display: "block", fontSize: 13, color: "#57606a", marginBottom: 4 },
  textarea: { display: "block", width: "100%", minHeight: 48, marginTop: 4, padding: 8, border: "1px solid #ccc", borderRadius: 6, fontFamily: "inherit", fontSize: 14, boxSizing: "border-box" },
  hint: { fontSize: 13, color: "#57606a" },
  thLeft: { textAlign: "left" },
  tdCenter: { textAlign: "center" },
  wmBadge: { marginLeft: 6, fontSize: 12 },
  wmBadgeOff: { marginLeft: 6, fontSize: 11, color: "#57606a", border: "1px solid #d0d7de", borderRadius: 4, padding: "0 4px" },
  rowBtn: { padding: "5px 10px", fontSize: 13, marginRight: 6 },
  inviteRow: { display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid #eaeef2" },
  inviteStatus: { fontSize: 12, color: "#57606a", flex: 1 },
};
