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
  <slot />
</template>
