<!--
  Not in the brief's file list — added because `app.vue` uses `<NuxtLayout>`
  (Step 4, verbatim) and docs/site doesn't define its own "default" layout,
  so it inherits the desktop app's (`app/layouts/default.vue`): a sidebar
  with a live download-progress indicator (`useDownloads()`) that pulls in
  `watermarkClient.ts` -> `watermark.worker.ts`. That worker's cross-layer
  "~" imports don't survive Vite's isolated worker sub-build, which breaks
  `nuxt generate` outright (the client build discovers every registered
  layout/page up front, worker included). Designing docs/site's real layout
  is Task 2's job ("route re-prefixing and docs layout"); this is a bare
  passthrough only so this gate's `generate` isn't blocked by desktop-only
  chrome this task never asked for.
-->
<template>
  <slot />
</template>
