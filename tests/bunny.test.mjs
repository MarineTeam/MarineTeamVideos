import test from "node:test";
import assert from "node:assert/strict";

process.env.BUNNY_LIBRARY_ID = "12345";
process.env.BUNNY_API_KEY = "test-key";
delete process.env.BUNNY_PULL_ZONE; // keep thumbnails null, out of scope here

const { listVideos, listCollections } = await import("../lib/bunny.js");

// Serves `total` fake videos across pages of 100, recording the URLs asked
// for so the test can assert the pagination walk itself, not just the result.
function stubLibrary(total, { key = "videos" } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get("page") || 1);
    const start = (page - 1) * 100;
    const items = Array.from({ length: Math.max(0, Math.min(100, total - start)) }, (_, i) => ({
      guid: `${key}-${start + i}`,
      title: `Item ${start + i}`,
      name: `Item ${start + i}`,
      videoCount: 1,
      collectionId: "",
    }));
    return { ok: true, json: async () => ({ items, totalItems: total }) };
  };
  return calls;
}

test("a library of 250 videos returns all 250, not the first 100", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = stubLibrary(250);
  const videos = await listVideos();

  assert.equal(videos.length, 250, "video #101 onward must not be silently dropped");
  assert.equal(videos[0].id, "videos-0");
  assert.equal(videos[249].id, "videos-249");
  assert.equal(calls.length, 3, "expected three page requests for 250 items");
  assert.match(calls[0], /page=1/);
  assert.match(calls[2], /page=3/);
});

test("a library at or under one page makes exactly one request", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = stubLibrary(42);
  const videos = await listVideos();
  assert.equal(videos.length, 42);
  assert.equal(calls.length, 1, "must not make a speculative second request");
});

test("an exactly-full single page stops once totalItems is satisfied", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = stubLibrary(100);
  const videos = await listVideos();
  assert.equal(videos.length, 100);
  // The first page is full, so the walk asks once more and gets an empty
  // page; it must not loop past that.
  assert.ok(calls.length <= 2, `expected at most 2 calls, got ${calls.length}`);
});

test("collections paginate the same way", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  stubLibrary(150, { key: "coll" });
  const collections = await listCollections();
  assert.equal(collections.length, 150);
  assert.equal(collections[0].id, "coll-0");
});

test("an API error surfaces instead of returning a short list", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => "Unauthorized" });
  await assert.rejects(() => listVideos(), /Bunny API error: 401/);
});
