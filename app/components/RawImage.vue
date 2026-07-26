<script setup lang="ts">
import { useCameraTransport } from "~/utils/transport";
import { extractDngPreview } from "~/utils/dng";
import { parseRawImageMeta, decodeRawPreview } from "~/utils/rawPreview";
import { formatBytes } from "~/utils/media";
import { withCameraSlot, CAMERA_PRIORITY } from "~/utils/cameraQueue";
import { cachedMedia } from "~/utils/mediaCache";

/**
 * Shows a RAW (e.g. DNG) file. Prefers an embedded preview JPEG; when the file
 * has none (the Luna's DNGs are raw Bayer only) and we hold the whole file, it
 * decodes the sensor data into a preview. For grid thumbnails pass `maxBytes`
 * to range-fetch only the start of the file (cheap) — those never raw-decode.
 * Falls back to the `fallback` slot when no preview can be produced.
 *
 * The derived preview goes through the session media cache, so reopening a RAW
 * skips both the multi-MB download and the CPU-bound Bayer decode. Only that
 * small preview is cached — never the source buffer.
 */
const {
  src,
  imgClass = "",
  eager = false,
  prefer = "largest",
  maxBytes,
} = defineProps<{
  src: string;
  ext: string;
  imgClass?: string;
  eager?: boolean;
  prefer?: "largest" | "smallest";
  /** Range-limit the download; the preview must fall within these bytes */
  maxBytes?: number;
}>();

const el = useTemplateRef("el");
const imgSrc = ref<string | null>(null);
const state = ref<"idle" | "loading" | "loaded" | "nopreview" | "error">("idle");
const phase = ref<"downloading" | "decoding">("downloading");
const downloaded = ref(0);
const total = ref(0);
/** Which stage failed — surfaced in the fallback UI so failures are diagnosable. */
const reason = ref<"network" | "range-skipped" | "no-preview" | "decode-failed" | null>(null);

/** Whether this instance shows the full file (full-screen), not a grid thumb. */
const fullFile = computed(() => !maxBytes);
const percent = computed(() =>
  total.value ? Math.round((downloaded.value / total.value) * 100) : 0,
);

let observer: IntersectionObserver | null = null;

/**
 * Download the response body, reporting byte progress as it streams so a large
 * RAW (tens of MB over the camera's Wi-Fi) shows movement instead of an opaque
 * spinner. Falls back to a plain buffered read when the body isn't streamable.
 */
async function downloadBuffer(response: Response): Promise<ArrayBuffer> {
  total.value = Number(response.headers.get("content-length") ?? 0);
  const body = response.body;
  if (!body) return await response.arrayBuffer();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      // Copy each chunk: if the stream implementation reuses its buffer across
      // reads, held references would all alias the last chunk's bytes and the
      // assembled file would be silently corrupt.
      chunks.push(new Uint8Array(value));
      received += value.length;
      downloaded.value = received;
    }
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
}

/**
 * Render an uncompressed CFA RAW (e.g. Insta360 Luna DNG) to a preview JPEG
 * data URL via canvas. Synchronous encode (toDataURL) is used deliberately: it
 * can't leave us waiting on a canvas.toBlob callback that never fires. Returns
 * null when the file isn't a supported raw or the canvas is unavailable.
 */
function decodeRawToDataUrl(buffer: ArrayBuffer): string | null {
  try {
    const meta = parseRawImageMeta(buffer);
    if (!meta) return null;
    const decoded = decodeRawPreview(buffer, meta, 1600);
    if (!decoded) return null;
    const canvas = document.createElement("canvas");
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.putImageData(new ImageData(decoded.data, decoded.width, decoded.height), 0, 0);
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    // An allocation or canvas failure must read as decode-failed, not no-preview.
    return null;
  }
}

/**
 * The cache holds one value per RAW: an embedded preview `Blob`, a `data:` URL
 * from the Bayer decode, or a `nopreview:<reason>` token. The three domains are
 * disjoint, so the token round-trips the failure reason through the cache and a
 * cached miss still explains itself in the fallback UI.
 */
const NO_PREVIEW = "nopreview:";

/**
 * Download and derive the preview for this RAW. Runs only on a cache miss; the
 * progress refs it drives are why it stays a closure over component state.
 */
async function fetchPreview(priority: number): Promise<Blob | string> {
  const download = () =>
    withCameraSlot(async () => {
      const init: RequestInit = maxBytes ? { headers: { Range: `bytes=0-${maxBytes - 1}` } } : {};
      const response = await useCameraTransport().fetch(src, init);
      if (!response.ok) throw new Error(String(response.status));
      // If we asked for a byte range (grid thumbnail) but the camera ignored it
      // and would send the whole multi-MB file, skip rather than download it.
      if (maxBytes && response.status !== 206) {
        const len = Number(response.headers.get("content-length") ?? 0);
        if (len === 0 || len > maxBytes * 2) return null;
      }
      return await downloadBuffer(response);
    }, priority);

  // Hold one camera slot for the entire download (fetch + streamed read); the
  // CPU-bound decode below runs after the slot is released. The camera can
  // drop a minutes-long transfer, so the full-screen path retries transient
  // failures like the reference app does.
  let buffer: ArrayBuffer | null = null;
  const maxAttempts = fullFile.value ? 3 : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      buffer = await download();
      break;
    } catch (e) {
      if (attempt >= maxAttempts) throw e;
      downloaded.value = 0;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }

  if (buffer === null) return `${NO_PREVIEW}range-skipped`;

  // Fast path: an embedded preview JPEG (many RAW formats carry one).
  const embedded = extractDngPreview(buffer, prefer);
  if (embedded) return embedded;

  // No embedded JPEG: if we hold the whole file (full-screen view, not a grid
  // range-fetch), decode the raw Bayer sensor data into a preview.
  if (fullFile.value) {
    phase.value = "decoding";
    await nextTick(); // let the "Rendering preview…" state paint before the sync decode
    return decodeRawToDataUrl(buffer) ?? `${NO_PREVIEW}decode-failed`;
  }

  return `${NO_PREVIEW}no-preview`;
}

async function load() {
  if (state.value !== "idle") return;
  state.value = "loading";
  phase.value = "downloading";
  // Full-screen preview outranks grid thumbnails for the shared camera slots.
  const priority = maxBytes ? CAMERA_PRIORITY.THUMBNAIL : CAMERA_PRIORITY.PREVIEW;
  // Key on everything that changes the derived output: a range-limited grid
  // thumbnail and a full-file preview of one file are different artifacts.
  const key = `raw:${src}:${maxBytes ?? "full"}:${prefer}`;
  try {
    const result = await cachedMedia(key, () => fetchPreview(priority));

    if (!result || (typeof result === "string" && result.startsWith(NO_PREVIEW))) {
      reason.value = result
        ? (result.slice(NO_PREVIEW.length) as typeof reason.value)
        : "no-preview";
      state.value = "nopreview";
      return;
    }

    imgSrc.value = typeof result === "string" ? result : URL.createObjectURL(result);
    state.value = "loaded";
  } catch {
    reason.value = "network";
    state.value = "error";
  }
}

onMounted(async () => {
  await nextTick();
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
  // Only object URLs need revoking; data URLs (raw decode output) don't.
  if (imgSrc.value?.startsWith("blob:")) URL.revokeObjectURL(imgSrc.value);
});
</script>

<template>
  <!-- Centered so a photo whose aspect ratio differs from the container sits in
       the middle instead of hugging the left edge. -->
  <div ref="el" class="relative flex size-full items-center justify-center">
    <img
      v-if="state === 'loaded' && imgSrc"
      :src="imgSrc"
      alt=""
      draggable="false"
      :class="imgClass"
    />

    <slot v-else-if="state === 'nopreview' || state === 'error'" name="fallback" :ext :reason>
      <div
        class="flex size-full flex-col items-center justify-center gap-1.5 bg-elevated text-dimmed"
      >
        <UIcon name="i-lucide-aperture" class="size-6" />
        <span class="font-mono text-[10px] uppercase tracking-wide">{{ ext }}</span>
      </div>
    </slot>

    <div
      v-else
      class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-elevated text-dimmed"
    >
      <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
      <p v-if="fullFile" class="text-center text-xs">
        <template v-if="phase === 'downloading'">
          Downloading RAW… {{ total ? `${percent}%` : formatBytes(downloaded) }}
        </template>
        <template v-else>Rendering preview…</template>
      </p>
    </div>
  </div>
</template>
