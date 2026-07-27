/**
 * Paces the live-view fixture so it plays back at roughly the speed it was
 * encoded at, instead of arriving as one instant localhost download.
 *
 * `LiveView.vue` (desktop-app source, frozen for this project) fetches its
 * annexb stream URL with a plain `fetch()` and feeds whatever bytes arrive to
 * WebCodecs as fast as they show up — there is no real-time pacing built in,
 * because on a real camera the network itself is the pacing. Over localhost,
 * a ~1.8 MB file arrives essentially all at once, so a ~12s-encoded clip
 * decodes and paints in well under a second: a blink, then a freeze. That
 * also means an end-of-stream detector watching for the fetch to complete
 * (see the `PerformanceObserver` in `docs/site/app/layouts/demo.vue`) fires
 * while the video is still visibly decoding, not once it is actually done —
 * the two problems share this one root cause.
 *
 * This worker fixes both by intercepting *only* the fixture request and
 * replacing its response body with a `ReadableStream` that trickles the same
 * bytes out on a timer targeting the clip's real encoded duration. Every
 * other request is left completely alone — the whole point is a narrow,
 * single-purpose interception, not a general-purpose cache.
 */

/** Suffix-matched, not an absolute path: this file is served under whatever base path the site deploys to, and must not hardcode it. */
const LIVE_VIEW_SUFFIX = "/demo/fixtures/liveview.264";

/** The generator (`scripts/make-fixtures.mjs`) encodes this clip as `d=12:r=30`. */
const TARGET_DURATION_MS = 12_000;
const CHUNK_INTERVAL_MS = 33;
const CHUNK_COUNT = Math.round(TARGET_DURATION_MS / CHUNK_INTERVAL_MS);

/**
 * `skipWaiting` + `clients.claim()` (rather than a versioned cache name —
 * this worker never touches the Cache Storage API at all) is what makes a
 * redeploy take effect on the very next load instead of leaving a stale
 * worker in control until every open tab closes.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.endsWith(LIVE_VIEW_SUFFIX)) return; // not the fixture: don't touch it

  event.respondWith(pacedFixtureResponse(event.request));
});

async function pacedFixtureResponse(request) {
  try {
    const upstream = await fetch(request);
    if (!upstream.ok || !upstream.body) return upstream;

    const bytes = new Uint8Array(await upstream.arrayBuffer());
    const stream = paceBytes(bytes);
    return new Response(stream, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  } catch {
    // Pacing is a best-effort nicety, never a requirement: if anything above
    // throws, fall through to a completely ordinary, unpaced fetch rather
    // than fail the request the demo's whole live-view flow depends on.
    return fetch(request);
  }
}

function paceBytes(bytes) {
  const total = bytes.byteLength;
  const chunkSize = Math.max(1, Math.ceil(total / CHUNK_COUNT));

  return new ReadableStream({
    start(controller) {
      const startedAt = performance.now();
      let offset = 0;
      let chunkIndex = 0;

      const pump = () => {
        if (offset >= total) {
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkSize, total);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
        chunkIndex += 1;

        // Scheduled against an absolute target time, not a fixed per-call
        // delay: a naive `setTimeout(pump, CHUNK_INTERVAL_MS)` measured ~14.5s
        // of actual delivery for a 12s target, because each call's own
        // overhead (timer granularity, the enqueue() itself) is small but
        // compounds over ~360 iterations. Computing the delay as "how long
        // until the next proportional target instant" self-corrects for that
        // drift instead of accumulating it.
        const targetElapsed = (chunkIndex / CHUNK_COUNT) * TARGET_DURATION_MS;
        const delay = Math.max(0, targetElapsed - (performance.now() - startedAt));
        setTimeout(pump, delay);
      };
      pump();
    },
  });
}
