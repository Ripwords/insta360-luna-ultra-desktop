<script setup lang="ts">
import { useCameraTransport } from "~/utils/transport";
import { imageMimeFor } from "~/utils/media";
import { withCameraSlot, CAMERA_PRIORITY, viewportPriority } from "~/utils/cameraQueue";
import { cachedMedia } from "~/utils/mediaCache";

/**
 * Loads a camera image through the Tauri HTTP plugin (the camera's plain-HTTP
 * host can't be used as a direct <img src> from the packaged app), converts it
 * to an object URL, and only fetches once it scrolls near the viewport.
 *
 * The downloaded blob goes through the session media cache, so scrolling a tile
 * away and back — or opening the same photo full-screen — costs no Wi-Fi
 * transfer. This component still owns its own object URL, created per mount and
 * revoked on unmount; the cache owns only the blob.
 */
const {
  src,
  imgClass = "",
  eager = false,
} = defineProps<{
  src: string;
  alt: string;
  imgClass?: string;
  eager?: boolean;
}>();

const emit = defineEmits<{
  /** Fired once the browser has decoded the image; carries its real pixel size. */
  loaded: [dimensions: { width: number; height: number }];
}>();

function onImgLoad(event: Event) {
  const img = event.target as HTMLImageElement;
  if (img.naturalWidth && img.naturalHeight) {
    emit("loaded", { width: img.naturalWidth, height: img.naturalHeight });
  }
}

const el = useTemplateRef("el");
const objectUrl = ref<string | null>(null);
const state = ref<"idle" | "loading" | "loaded" | "error">("idle");

let observer: IntersectionObserver | null = null;

async function load() {
  if (state.value !== "idle") return;
  state.value = "loading";
  // Full-screen views (eager) outrank grid thumbnails; a thumbnail's priority
  // tracks its live distance to the viewport so loading follows the scroll.
  const priority = eager ? CAMERA_PRIORITY.PREVIEW : () => viewportPriority(el.value);
  try {
    // The camera slot is taken inside the loader so a cache hit never queues
    // behind live camera traffic.
    const blob = await cachedMedia(`img:${src}`, () =>
      withCameraSlot(async () => {
        const response = await useCameraTransport().fetch(src);
        if (!response.ok) throw new Error(String(response.status));
        const raw = await response.blob();
        // The camera may serve images as octet-stream; force the right MIME so
        // the browser renders the blob (fixes .insp and mistyped JPEGs).
        const mime = imageMimeFor(src);
        return mime && raw.type !== mime ? new Blob([raw], { type: mime }) : raw;
      }, priority),
    );
    if (!blob) throw new Error("no image");
    objectUrl.value = URL.createObjectURL(blob);
    state.value = "loaded";
  } catch {
    state.value = "error";
  }
}

onMounted(() => {
  if (eager || !("IntersectionObserver" in window) || !el.value) {
    void load();
    return;
  }
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer?.disconnect();
        void load();
      }
    },
    { rootMargin: "300px" },
  );
  observer.observe(el.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value);
});
</script>

<template>
  <!-- Centered so a photo whose aspect ratio differs from the container sits in
       the middle instead of hugging the left edge. -->
  <div ref="el" class="relative flex size-full items-center justify-center">
    <img
      v-if="state === 'loaded' && objectUrl"
      :src="objectUrl"
      :alt
      draggable="false"
      :class="imgClass"
      @load="onImgLoad"
    />
    <div
      v-else
      class="flex size-full items-center justify-center bg-elevated"
      :aria-busy="state === 'loading'"
    >
      <UIcon v-if="state === 'error'" name="i-lucide-image-off" class="size-5 text-dimmed" />
      <UIcon v-else name="i-lucide-loader-circle" class="size-5 animate-spin text-dimmed" />
    </div>
  </div>
</template>
