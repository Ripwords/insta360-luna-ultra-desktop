<script setup lang="ts">
// `getCameraTransport` lives in the layer (repo root `app/utils/transport.ts`)
// and is deliberately NOT imported here: the "~" alias only ever points at
// *this app's own* srcDir (docs/site/app), it does not cross layer
// boundaries, so `import ... from "~/utils/transport"` 404s from this app.
// Cross-layer utils are reachable only through Nuxt's auto-import scanning,
// which does cover every extended layer's `utils/` dir — so calling
// `getCameraTransport` with no import at all proves three things at once:
// layer component resolution, layer util resolution via auto-import, and
// that the transport registry is reachable from this app.
const transportAvailable = getCameraTransport().available;
</script>

<template>
  <UContainer class="py-16">
    <h1 class="text-2xl font-semibold text-highlighted">Layer probe</h1>
    <p class="mt-2 text-muted">
      Transport available: {{ transportAvailable }} (expected false — no Tauri runtime here)
    </p>
    <CameraStatusChip class="mt-6" />
  </UContainer>
</template>
