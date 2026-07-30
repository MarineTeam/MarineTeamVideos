import { getSettings, saveSettings } from "../../lib/settings";
import { adminGeoWhitelist, adminGeoBypassEmails, recipientGeoWhitelist } from "../../lib/geo";
import { withApiMonitor } from "../../lib/withMonitor";

// Admin-only. Not under /api/watch/ or /api/bundle/, so the middleware matcher
// puts it behind Basic Auth automatically (invariant 7) — no per-route check
// needed here. GET reads current settings; POST saves a patch.
async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const settings = await getSettings();
      // geoWhitelistCountries / adminGeoWhitelistCountries are READ-ONLY
      // decoration sourced from env vars, not the KV record — shown in the
      // admin UI so an admin can see what's configured, but saveSettings
      // below never accepts or persists either (see lib/geo.js for why both
      // lists must stay outside anything the admin UI can edit).
      return res.status(200).json({
        settings: {
          ...settings,
          geoWhitelistCountries: recipientGeoWhitelist(),
          adminGeoWhitelistCountries: adminGeoWhitelist(),
          adminGeoBypassEmails: adminGeoBypassEmails(),
        },
      });
    }
    if (req.method === "POST") {
      const settings = await saveSettings(req.body || {});
      return res.status(200).json({ ok: true, settings });
    }
    return res.status(405).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default withApiMonitor(handler);
