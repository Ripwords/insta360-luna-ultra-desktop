<script setup lang="ts">
// `getCameraTransport` lives in the layer (repo root `app/utils/transport.ts`).
// The plain "~" alias always resolves against *this app's own* srcDir
// (docs/site/app), never the layer's, for both types and values — so
// `import ... from "~/utils/transport"` 404s from this app. `#layer` (see
// nuxt.config.ts) points at the layer's srcDir directly, so this explicit
// import — including the type import below — resolves and typechecks.
// Using it here proves three things at once: layer component resolution
// (CameraStatusChip), layer util resolution via an explicit cross-layer
// import, and that the transport registry is reachable from this app.
import { getCameraTransport } from "#layer/utils/transport";
import type { CameraTransport } from "#layer/utils/transport";

const transport: CameraTransport = getCameraTransport();
const transportAvailable = transport.available;
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
