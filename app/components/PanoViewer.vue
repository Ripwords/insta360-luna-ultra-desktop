<script setup lang="ts">
import "pannellum/build/pannellum.css";
import { cameraFetch } from "~/utils/lunaClient";
import { imageMimeFor } from "~/utils/media";
import { withCameraSlot, CAMERA_PRIORITY } from "~/utils/cameraQueue";

/**
 * Interactive 360 / panorama viewer built on Pannellum. The equirectangular
 * image is fetched through the camera bridge, wrapped as a same-origin object
 * URL (so the WebGL texture isn't tainted) and handed to Pannellum.
 */
const props = defineProps<{ src: string }>();

const container = useTemplateRef("container");
const state = ref<"loading" | "ready" | "error">("loading");

let viewer: PannellumViewer | null = null;
let objectUrl: string | null = null;

onMounted(async () => {
  await nextTick();
  if (!container.value) return;
  try {
    const blob = await withCameraSlot(async () => {
      const response = await cameraFetch(props.src);
      if (!response.ok) throw new Error(String(response.status));
      const raw = await response.blob();
      const mime = imageMimeFor(props.src);
      return mime && raw.type !== mime ? new Blob([raw], { type: mime }) : raw;
    }, CAMERA_PRIORITY.PREVIEW);
    objectUrl = URL.createObjectURL(blob);

    // UMD build: attaches window.pannellum as a side effect
    await import("pannellum/build/pannellum.js");
    const pannellum = window.pannellum;
    if (!pannellum) throw new Error("Pannellum failed to initialise");

    viewer = pannellum.viewer(container.value, {
      type: "equirectangular",
      panorama: objectUrl,
      autoLoad: true,
      draggable: true,
      mouseZoom: true,
      showZoomCtrl: true,
      showFullscreenCtrl: false,
      compass: false,
      crossOrigin: "anonymous",
    });
    viewer.on("load", () => {
      state.value = "ready";
    });
    viewer.on("error", () => {
      state.value = "error";
    });
  } catch {
    state.value = "error";
  }
});

onBeforeUnmount(() => {
  try {
    viewer?.destroy();
  } catch {
    // viewer may not be fully constructed
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});
</script>

<template>
  <!-- WKWebView hijacks mouse-drag for native text/image selection unless
       these are suppressed, which stops Pannellum from panning. -->
  <div class="pano-root relative size-full">
    <div ref="container" class="size-full" />

    <div
      v-if="state === 'loading'"
      class="pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin text-dimmed" />
    </div>

    <div
      v-else-if="state === 'error'"
      class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-muted"
    >
      <UIcon name="i-lucide-globe" class="size-8 text-dimmed" />
      <p class="text-sm">Couldn't open this panorama. Download it to view in another app.</p>
    </div>
  </div>
</template>

<style scoped>
.pano-root,
.pano-root :deep(.pnlm-container),
.pano-root :deep(.pnlm-render-container),
.pano-root :deep(.pnlm-dragfix),
.pano-root :deep(canvas) {
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
  -webkit-touch-callout: none;
}
</style>
