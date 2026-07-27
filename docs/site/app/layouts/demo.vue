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
</script>

<template>
  <div class="relative">
    <AppShell>
      <slot />
    </AppShell>

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
