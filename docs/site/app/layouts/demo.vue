<script setup lang="ts">
// `nuxt-seo-utils` is documented to read a route's `page.meta.robots` (set in
// the `pages:extend` hook in `nuxt.config.ts`) and emit the matching
// `<meta name="robots">` automatically. Verified against the generated
// output that it does not: /demo/* pages still got the site's normal
// "index, follow" tag. There was also no pre-existing `demo` layout file for
// the layer's inherited pages to resolve to — `page.meta.layout = "demo"`
// silently matched nothing, so those pages rendered with no Nuxt layout
// wrapper at all (their header/chrome comes from the page component itself,
// e.g. `UDashboardPanel`). Adding this file both gives `layout: "demo"`
// something real to resolve to (a plain passthrough, so it changes nothing
// visually) and is where the robots tag actually gets set, per the task
// brief's documented fallback for exactly this situation.
useSeoMeta({
  robots: "noindex, nofollow",
});

/**
 * The Annex-B fixture behind live view (`public/demo/fixtures/liveview.264`)
 * is a finite clip, and `LiveView.vue` — desktop-app source, off limits here
 * — has no concept of looping: its `consumeAnnexB` loop simply returns when
 * the fetch body ends, leaving the canvas frozen on the last decoded frame.
 * `useLiveView()`'s own `active` flag never flips back to false on a natural
 * end (only an explicit `stop()` does that), so there is nothing in its
 * exposed state to watch directly for "the clip finished".
 *
 * What *is* observable from outside the component is the underlying network
 * request: the Resource Timing entry for the fixture URL gets a non-zero
 * `responseEnd` once the browser finishes downloading it, which happens at
 * essentially the same moment `consumeAnnexB`'s read loop exits. Watching for
 * that gives an honest, external end-of-stream signal without touching
 * `LiveView.vue` or hardcoding the fixture's duration.
 */
const { active, transport, streamUrl, stop, start } = useLiveView();

const streamEnded = ref(false);
let stopWatchingResource: (() => void) | null = null;

/**
 * `buffered: false` (the default) means the observer only reports entries
 * created *after* `observe()` runs — exactly what is wanted here, since a
 * replay reuses the same fixture URL and a stale completed entry from the
 * previous playthrough must never be mistaken for the new one finishing.
 */
function watchForStreamEnd(absoluteUrl: string, onEnded: () => void): () => void {
  if (typeof PerformanceObserver === "undefined") return () => {};
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name === absoluteUrl && (entry as PerformanceResourceTiming).responseEnd > 0) {
        onEnded();
        return;
      }
    }
  });
  observer.observe({ type: "resource" });
  return () => observer.disconnect();
}

watch(
  [active, transport, streamUrl],
  ([isActive, kind, url]) => {
    stopWatchingResource?.();
    stopWatchingResource = null;
    streamEnded.value = false;
    if (!isActive || kind !== "annexb" || !url) return;
    const absolute = new URL(url, location.href).href;
    stopWatchingResource = watchForStreamEnd(absolute, () => {
      streamEnded.value = true;
    });
  },
  { immediate: true },
);

onBeforeUnmount(() => stopWatchingResource?.());

/** `start()` no-ops while `active` is already true, so a replay must stop first. */
async function replay() {
  streamEnded.value = false;
  await stop();
  await start();
}

/**
 * No note added here for missing WebCodecs support, deliberately: tested by
 * deleting `window.VideoDecoder` before starting live view, and the failure
 * is not silent. `LiveView.vue`'s `new VideoDecoder(...)` throws a
 * `ReferenceError`, which its own watcher already catches and writes to
 * `useLiveView()`'s `error` state — surfaced by the existing `topError`
 * banner in `app/pages/camera.vue` ("VideoDecoder is not defined"). The task
 * brief's instruction to add an explanatory note here was conditioned on the
 * canvas going blank with no explanation; that condition does not hold, so
 * nothing was added.
 */
</script>

<template>
  <div class="relative">
    <AppShell>
      <slot />
    </AppShell>

    <div
      v-if="streamEnded"
      class="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center px-4"
      role="status"
    >
      <button
        type="button"
        class="pointer-events-auto flex items-center gap-1.5 rounded-full bg-inverted/90 px-3 py-1.5 text-xs font-medium text-inverted shadow-lg backdrop-blur"
        @click="replay"
      >
        <UIcon name="i-lucide-refresh-cw" class="size-3.5" />
        Live view clip ended — replay
      </button>
    </div>

    <div
      class="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center pb-3"
      role="status"
    >
      <span
        class="pointer-events-auto rounded-full bg-inverted/90 px-3 py-1.5 text-xs font-medium text-inverted shadow-lg backdrop-blur"
      >
        Simulated camera — live view and capture are pre-recorded
      </span>
    </div>
  </div>
</template>
