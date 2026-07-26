import crypto from "crypto";

const BUNNY_API_BASE = "https://video.bunnycdn.com/library";

// Lists videos in your Bunny Stream library
export async function listVideos() {
  const libraryId = process.env.BUNNY_LIBRARY_ID;
  const apiKey = process.env.BUNNY_API_KEY;

  const res = await fetch(
    `${BUNNY_API_BASE}/${libraryId}/videos?itemsPerPage=100&orderBy=date`,
    { headers: { AccessKey: apiKey, accept: "application/json" } }
  );

  if (!res.ok) {
    throw new Error(`Bunny API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const pullZone = process.env.BUNNY_PULL_ZONE; // e.g. vz-xxxxxxxx-abc.b-cdn.net

  return (data.items || []).map((v) => ({
    id: v.guid,
    title: v.title,
    length: v.length,
    // Bunny's own grouping of videos within a library — a video with no
    // collection assigned in the Bunny dashboard has an empty string here,
    // never null/undefined, so callers can key a lookup map on it directly.
    collectionId: v.collectionId || "",
    thumbnail: pullZone
      ? signCdnUrl(`https://${pullZone}/${v.guid}/${v.thumbnailFileName}`)
      : null,
  }));
}

// Lists the collections defined in your Bunny Stream library (the same
// "collection" a video's collectionId above refers to). Used to label and
// group the admin grid, and to power "share this whole collection" — which
// just selects every video whose collectionId matches and hands them to the
// existing Bulk Share flow (pages/index.js), no separate sharing machinery.
export async function listCollections() {
  const libraryId = process.env.BUNNY_LIBRARY_ID;
  const apiKey = process.env.BUNNY_API_KEY;

  const res = await fetch(
    `${BUNNY_API_BASE}/${libraryId}/collections?itemsPerPage=100&orderBy=name`,
    { headers: { AccessKey: apiKey, accept: "application/json" } }
  );

  if (!res.ok) {
    throw new Error(`Bunny API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return (data.items || []).map((c) => ({
    id: c.guid,
    name: c.name,
    videoCount: c.videoCount,
  }));
}

// Signs a direct CDN URL (thumbnails, previews, HLS, MP4) per Bunny's
// "Pull Zone Token Authentication" scheme. Required whenever Token
// Authentication is enabled on the pull zone backing the Stream library —
// otherwise unsigned requests (like a plain <img src>) get a 403.
// This is a DIFFERENT key from BUNNY_TOKEN_KEY above: that one is the
// Stream library's Embed View Token, found under Library > API > Security.
// This one is the Pull Zone's own key, found under Library > API >
// "CDN zone management" > Manage > Security > Token Authentication.
function signCdnUrl(url, expiresInSeconds = 3600) {
  const securityKey = process.env.BUNNY_CDN_TOKEN_KEY;
  if (!securityKey) return url; // token auth not configured; return as-is

  const { pathname, origin } = new URL(url);
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const hashable = securityKey + pathname + expires;

  let token = crypto.createHash("sha256").update(hashable).digest("base64");
  token = token.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  return `${origin}${pathname}?token=${token}&expires=${expires}`;
}

// Generates a time-limited, signed embed URL for a given video
// per Bunny's "Embedded View Token Authentication" scheme.
export function generateEmbedUrl(videoId, expiresInSeconds = 3600) {
  const securityKey = process.env.BUNNY_TOKEN_KEY;
  const libraryId = process.env.BUNNY_LIBRARY_ID;
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;

  const hashable = securityKey + videoId + expires;
  const token = crypto.createHash("sha256").update(hashable).digest("hex");

  return `https://iframe.mediadelivery.net/embed/${libraryId}/${videoId}?token=${token}&expires=${expires}`;
}
