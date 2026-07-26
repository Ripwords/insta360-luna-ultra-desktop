<script setup lang="ts">
import { drawWatermark } from "~/utils/watermark";
import { placeholderDataUrl } from "~/utils/placeholder";
import { getCameraTransport } from "~/utils/transport";

/** A real camera photo URL to preview the watermark on. */
const props = defineProps<{ src?: string }>();

const { settings } = useWatermarkSettings();
const canvas = useTemplateRef<HTMLCanvasElement>("canvas");
const loading = ref(true);

let image: HTMLImageElement | null = null;
let objectUrl: string | null = null;
let renderToken = 0;

async function render() {
  const el = canvas.value;
  if (!el || !image) return;
  const token = ++renderToken;
  el.width = image.naturalWidth;
  el.height = image.naturalHeight;
  const ctx = el.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(image, 0, 0);
  try {
    await drawWatermark(ctx, el.width, el.height, { ...settings.value, enabled: true });
  } catch {
    // Watermark asset unavailable: preview stays unwatermarked
  }
  if (token !== renderToken && image) ctx.drawImage(image, 0, 0);
}

function setImage(src: string) {
  const next = new Image();
  next.onload = () => {
    image = next;
    loading.value = false;
    void render();
  };
  next.onerror = () => {
    if (image) return;
    image = new Image();
    image.onload = () => {
      loading.value = false;
      void render();
    };
    image.src = placeholderDataUrl("watermark-sample", 1600, 900);
  };
  next.src = src;
}

async function loadFromCamera() {
  if (!props.src) {
    setImage(placeholderDataUrl("watermark-sample", 1600, 900));
    return;
  }
  try {
    const response = await getCameraTransport().fetch(props.src);
    if (!response.ok) throw new Error(String(response.status));
    const blob = await response.blob();
    objectUrl = URL.createObjectURL(blob);
    setImage(objectUrl);
  } catch {
    setImage(placeholderDataUrl("watermark-sample", 1600, 900));
  }
}

onMounted(loadFromCamera);

watch(settings, () => void render(), { deep: true });

onBeforeUnmount(() => {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});
</script>

<template>
  <div class="relative overflow-hidden rounded-xl border border-default bg-muted">
    <USkeleton v-if="loading" class="aspect-video w-full" />
    <canvas v-show="!loading" ref="canvas" class="block w-full" aria-label="Watermark preview" />
  </div>
</template>
