<script setup lang="ts">
// Hand-rolled JSON-LD injection — deliberately not `useSchemaOrg()`.
//
// `nuxt-schema-org`'s `useSchemaOrg()` / `defineSoftwareApp()` resolve and
// typecheck fine (both are auto-imported per Nuxt's generated
// `imports.d.ts`), but produce an EMPTY `<script type="application/ld+json">`
// tag in the actually-generated static HTML — verified directly against
// `docs/site/.output/public/index.html`.
//
// The cause is a real, pre-existing dependency conflict, not a usage
// mistake: `nuxt-schema-org` and `@unhead/schema-org` pin `unhead` /
// `@unhead/vue` to `^2.x`, while Nuxt 4 itself requires `^3.1.8`. Both major
// versions end up installed side by side — `node_modules/@unhead/vue`
// resolves to 2.1.16 (hoisted for the schema-org packages), while
// `node_modules/nuxt/node_modules/@unhead/vue` (and
// `@nuxt/nitro-server`'s own copy) is 3.2.1. `nuxt-schema-org`'s Unhead
// plugin is built against the v2 API but registers itself on the actual
// (v3) Head instance the page renders through, so its
// `entries:normalize`/`tags:resolve` hooks never fire against the real
// render pass — the tag keeps its initial empty `innerHTML` instead of
// being replaced with the serialized graph, and nothing throws to signal
// it.
//
// This bypasses that broken integration and injects the JSON-LD through
// plain `useHead()` — Nuxt's own core API, already confirmed to work
// correctly elsewhere on this page (title, meta description, canonical).
const { data } = defineProps<{
  data: Record<string, unknown>;
}>();

useHead({
  script: [
    {
      type: "application/ld+json",
      innerHTML: JSON.stringify(data),
    },
  ],
});
</script>

<template></template>
