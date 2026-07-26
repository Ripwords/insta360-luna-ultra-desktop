<script setup lang="ts">
import { withCameraSlot, CAMERA_PRIORITY, viewportPriority } from "~/utils/cameraQueue";

/**
 * Video thumbnail: a real <video> element on the camera's HTTP URL, seeked to
 * its first frame. Direct network src is the approach that actually decodes in
 * the packaged WKWebView — blob: URLs work for <img> but WKWebView's media
 * stack fails to play <video src="blob:..."> (verified on-device: photos as
 * blobs render, videos as blobs error, while the full-screen player's direct
 * http src plays fine).
 *
 * The camera's embedded HTTP server can't take a whole grid loading at once,
 * so each tile holds one of the shared camera slots while its <video> fetches
 * metadata + first frame, releasing it on first-frame/error/stall. Tries the
 * low-res LRV proxy first, then the full file.
 */
const {
  src,
  lrv,
  imgClass = "",
  eager = false,
} = defineProps<{
  /** Full-resolution source (the file that also plays back) */
  src: string;
  /** Optional low-res proxy to try first */
  lrv?: string;
  imgClass?: string;
  eager?: boolean;
}>();

const el = useTemplateRef("el");
const video = useTemplateRef<HTMLVideoElement>("video");
const activeSrc = ref<string | null>(null);
const state = ref<"idle" | "loading" | "loaded" | "error">("idle");

let observer: IntersectionObserver | null = null;
let stallTimer: ReturnType<typeof setTimeout> | null = null;
let releaseSlot: (() => void) | null = null;
let disposed = false;
let attempt = 0;

const sources = computed(() => {
  const list: string[] = [];
  if (lrv && lrv !== src) list.push(lrv);
  list.push(src);
  return list;
});

function clearStall() {
  if (stallTimer) {
    clearTimeout(stallTimer);
    stallTimer = null;
  }
}

/** Free the shared camera slot this tile is holding, if any. */
function settle() {
  clearStall();
  releaseSlot?.();
  releaseSlot = null;
}

function queueAttempt() {
  const source = sources.value[attempt];
  if (!source) {
    state.value = "error";
    return;
  }
  // Hold a camera slot while the <video> fetches metadata + first frame, so a
  // screenful of tiles loads a couple at a time instead of all at once. The
  // slot is released by onReady/onError/stall, not by the media element.
  void withCameraSlot(
    () =>
      new Promise<void>((resolve) => {
        if (disposed) {
          resolve();
          return;
        }
        releaseSlot = resolve;
        activeSrc.value = source;
        clearStall();
        // If WebKit silently never fires loadeddata/seeked/error (e.g. a
        // moov-at-end file), give up the slot and fall to the next source.
        stallTimer = setTimeout(() => {
          if (state.value !== "loaded") onError();
        }, 15_000);
      }),
    eager ? CAMERA_PRIORITY.PREVIEW : () => viewportPriority(el.value),
  );
}

function begin() {
  if (state.value !== "idle") return;
  state.value = "loading";
  attempt = 0;
  queueAttempt();
}

function onMeta() {
  const v = video.value;
  if (!v) return;
  // Seek a hair off zero — the very first frame is often black.
  try {
    v.currentTime = Math.min(0.1, (v.duration || 1) / 2);
  } catch {
    // Seeking unsupported: the loadeddata frame will have to do.
  }
}

function onReady() {
  settle();
  state.value = "loaded";
}

function onError() {
  settle();
  attempt++;
  queueAttempt();
}

onMounted(() => {
  if (eager || !("IntersectionObserver" in window) || !el.value) {
    begin();
    return;
  }
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer?.disconnect();
        begin();
      }
    },
    { rootMargin: "300px" },
  );
  observer.observe(el.value);
});

onBeforeUnmount(() => {
  disposed = true;
  observer?.disconnect();
  settle();
});
</script>

<template>
  <div ref="el" class="relative size-full">
    <video
      v-if="activeSrc"
      ref="video"
      :key="activeSrc"
      :src="activeSrc"
      muted
      playsinline
      preload="metadata"
      :class="[imgClass, state === 'loaded' ? '' : 'invisible']"
      @loadedmetadata="onMeta"
      @seeked="onReady"
      @loadeddata="onReady"
      @error="onError"
    />
    <div
      v-if="state !== 'loaded'"
      class="absolute inset-0 flex items-center justify-center bg-elevated"
    >
      <UIcon v-if="state === 'error'" name="i-lucide-film" class="size-5 text-dimmed" />
      <UIcon v-else name="i-lucide-loader-circle" class="size-5 animate-spin text-dimmed" />
    </div>
  </div>
</template>
