import crypto from "crypto";

const BUNNY_API_BASE = "https://video.bunnycdn.com/library";

// Bunny's list endpoints are paginated. We request the maximum page size and
// then keep asking for the next page until we've collected `totalItems` (or
// a page comes back short/empty). Before this loop existed both listers sent
// a single `itemsPerPage=100` request with no `page` param, so a library
// with more than 100 videos silently lost everything past the first page —
// video #101 simply never appeared in the admin grid and could never be
// shared. A library at or under one page behaves exactly as before: one
// request, same order, same shape.
const PAGE_SIZE = 100;
// Hard stop so a malformed/hostile `totalItems` can never spin forever.
// 200 pages x 100 = 20,000 items, far beyond this app's scale.
const MAX_PAGES = 200;

async function bunnyGet(path) {
  const apiKey = process.env.BUNNY_API_KEY;
  const res = await fetch(path, {
    headers: { AccessKey: apiKey, accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`Bunny API error: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

// Walks every page of a Bunny list endpoint and returns the concatenated
// `items`. `buildUrl(page)` must produce the URL for a 1-indexed page.
async function listAllPages(buildUrl) {
  const all = [];
  let totalItems = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await bunnyGet(buildUrl(page));
    const items = data.items || [];
    all.push(...items);

    if (typeof data.totalItems === "number") totalItems = data.totalItems;

    // Stop on a short or empty page (the last one), or once we've collected
    // everything the API says exists. Both conditions are checked because
    // neither alone is reliable across Bunny's list endpoints.
    if (items.length < PAGE_SIZE) break;
    if (totalItems !== null && all.length >= totalItems) break;
  }

  return all;
}

// Lists videos in your Bunny Stream library
export async function listVideos() {
  const libraryId = process.env.BUNNY_LIBRARY_ID;
  const pullZone = process.env.BUNNY_PULL_ZONE; // e.g. vz-xxxxxxxx-abc.b-cdn.net

  const items = await listAllPages(
    (page) =>
      `${BUNNY_API_BASE}/${libraryId}/videos?page=${page}&itemsPerPage=${PAGE_SIZE}&orderBy=date`
  );

  return items.map((v) => ({
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

  const items = await listAllPages(
    (page) =>
      `${BUNNY_API_BASE}/${libraryId}/collections?page=${page}&itemsPerPage=${PAGE_SIZE}&orderBy=name`
  );

  return items.map((c) => ({
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
