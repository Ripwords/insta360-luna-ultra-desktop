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
// something real to resolve to (this app's own macOS window chrome, see the
// template below) and is where the robots tag actually gets set, per the
// task brief's documented fallback for exactly this situation.
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

/**
 * `AppShell` (desktop-app source, off limits here) renders its
 * `UDashboardGroup` as `fixed inset-0`, so left alone it always paints over
 * the entire *browser viewport*, not just whatever box this layout puts it
 * in. That's exactly right for the embedded case (the iframe's own document
 * has no chrome of its own — `Demo.vue` draws a macOS window *around* the
 * iframe from outside it), but wrong for a top-level `/demo/*` visit, where
 * the whole point is for `AppShell` to sit inside a macOS window on the
 * page, not fill the browser tab.
 *
 * The fix is the `[transform:translateZ(0)]` on the content wrapper below:
 * any transform, on any ancestor, makes that ancestor the containing block
 * for `position: fixed` descendants instead of the viewport (CSS Transforms
 * §renders "if the transform property is anything other than none, it
 * establishes a new containing block"). `AppShell`'s `fixed inset-0`, and
 * this layout's own `fixed` status pills below, all resolve against that
 * wrapper's box instead of the real viewport once it has a transform — so
 * they fill and stay clipped to the window, not the page. The wrapper needs
 * a *definite* height for that to size correctly (an auto-height box whose
 * only children are fixed/out-of-flow would collapse to zero), which is why
 * it's a `flex-1` row of a flex column whose total height is set explicitly
 * on the window frame around it, not derived from content.
 */
const isTopLevelDemo = ref(false);
onMounted(() => {
  isTopLevelDemo.value = window.self === window.top;
});
</script>

<template>
  <div
    v-if="isTopLevelDemo"
    class="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_top,var(--ui-bg-elevated)_0%,var(--ui-bg)_65%)] p-4 sm:p-8"
  >
    <!--
      macOS window chrome for a top-level /demo/* visit — the same look
      `Demo.vue` draws around its embedded iframe (traffic lights, 11px
      radius, 36px title bar, hardcoded hairline), reused here rather than
      re-derived so the two never drift apart. `Demo.vue` keeps drawing its
      own copy for the embedded case; that iframe's *inner* document (this
      same layout, `v-else` below) draws none, so exactly one window frame
      is ever on screen in either context.

      Height is `min(46rem, 100dvh - 2rem)`: capped so the window doesn't
      loom on a tall monitor, but always clears a phone-sized viewport with
      a small margin either way.
    -->
    <div
      class="relative flex h-[min(46rem,calc(100dvh-2rem))] w-full max-w-5xl flex-col overflow-hidden rounded-[11px] bg-default shadow-2xl ring-1 ring-default"
    >
      <div
        class="relative flex h-9 shrink-0 items-center border-b border-black/10 bg-elevated px-3.5 dark:border-white/10"
      >
        <div class="flex items-center gap-2">
          <span class="size-3 rounded-full bg-[#ff5f57]" />
          <span class="size-3 rounded-full bg-[#febc2e]" />
          <span class="size-3 rounded-full bg-[#28c840]" />
        </div>

        <!--
          The disclosure: a top-level visit has no surrounding docs page to
          carry it (unlike the embedded case, where `Demo.vue`'s own title
          bar — outside the iframe — says the same thing regardless of which
          /demo/* screen the iframe is currently showing), so the title bar
          here is the one honesty surface every top-level screen shares.
        -->
        <span
          class="pointer-events-none absolute inset-x-0 text-center text-[13px] font-medium text-muted"
        >
          Luna Ultra Desktop — simulated camera
        </span>
      </div>

      <div class="relative min-h-0 flex-1 [transform:translateZ(0)]">
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

        <!--
          Only ever shown top-level: inside an embedded iframe this would
          both be redundant (the surrounding docs page is already right
          there) and actively wrong (it would navigate the iframe itself out
          from under the embed rather than doing anything useful).
        -->
        <NuxtLink
          to="/docs/install"
          class="pointer-events-auto fixed bottom-3 left-3 z-50 flex items-center gap-1.5 rounded-full bg-inverted/90 px-3 py-1.5 text-xs font-medium text-inverted shadow-lg backdrop-blur"
        >
          <UIcon name="i-lucide-arrow-left" class="size-3.5" />
          Back to docs
        </NuxtLink>
      </div>
    </div>
  </div>

  <!--
    Embedded case: `Demo.vue` already draws the window frame and its
    disclosure-carrying title bar from outside this iframe, so this half
    stays exactly the plain, chrome-free passthrough it always was —
    `AppShell` filling the iframe's own real viewport via its own
    `fixed inset-0`, no transform-containment needed because there's no
    surrounding page backdrop to clip it away from here.
  -->
  <div v-else class="relative">
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
  </div>
</template>
