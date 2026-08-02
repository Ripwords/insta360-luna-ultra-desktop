<script setup lang="ts">
import { HISTOGRAM_BINS, type Histogram } from "~/utils/histogram";

const { mode, histogram, available, cycle } = useHistogram();

const canvas = useTemplateRef<HTMLCanvasElement>("canvas");

/** Drawn size in CSS pixels. Small: this is an engraving, not a panel. */
const WIDTH = 112;
const HEIGHT = 44;

/** Below this share of the frame, clipping is noise rather than a warning. */
const CLIP_THRESHOLD = 0.002;

const label = computed(() => (mode.value === "rgb" ? "RGB" : "LUM"));

const clippedHighlights = computed(() => histogram.value.clippedHighlights > CLIP_THRESHOLD);
const clippedShadows = computed(() => histogram.value.clippedShadows > CLIP_THRESHOLD);

const title = computed(() =>
  mode.value === "luma" ? "Histogram: luma. Click for RGB." : "Histogram: RGB. Click to hide.",
);

/**
 * Square-root scaling rather than linear. A large flat area — sky, a wall —
 * puts one bin an order of magnitude above the rest, and under linear scaling
 * that spike flattens everything else to an invisible line. Any monotonic
 * curve preserves the two things you actually read off a histogram (where the
 * data sits, and whether it touches a rail), and this one keeps sparse
 * highlight detail visible, which is the part you most need to see.
 */
function barHeight(count: number, peak: number) {
  if (peak <= 0) return 0;
  return Math.sqrt(count / peak) * HEIGHT;
}

function drawChannel(
  context: CanvasRenderingContext2D,
  bins: Uint32Array,
  peak: number,
  style: string,
) {
  context.fillStyle = style;
  const binWidth = WIDTH / HISTOGRAM_BINS;
  for (let bin = 0; bin < HISTOGRAM_BINS; bin++) {
    const height = barHeight(bins[bin]!, peak);
    if (height <= 0) continue;
    context.fillRect(bin * binWidth, HEIGHT - height, binWidth, height);
  }
}

function draw(data: Histogram) {
  const element = canvas.value;
  if (!element) return;

  // Back the canvas at device resolution so 256 bins across 112px stay crisp.
  const ratio = window.devicePixelRatio || 1;
  const backingWidth = Math.round(WIDTH * ratio);
  const backingHeight = Math.round(HEIGHT * ratio);
  if (element.width !== backingWidth) element.width = backingWidth;
  if (element.height !== backingHeight) element.height = backingHeight;

  const context = element.getContext("2d");
  if (!context) return;

  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, WIDTH, HEIGHT);

  // Quarter-stop guides, so you can place the data rather than just see it.
  context.fillStyle = "rgba(255,255,255,0.12)";
  for (let quarter = 1; quarter < 4; quarter++) {
    context.fillRect(Math.round((WIDTH * quarter) / 4), 0, 1, HEIGHT);
  }

  if (data.total === 0) return;

  if (mode.value === "rgb") {
    // Additive, so overlapping channels read white exactly where they agree.
    context.globalCompositeOperation = "lighter";
    drawChannel(context, data.r, data.peak, "rgba(255,64,64,0.75)");
    drawChannel(context, data.g, data.peak, "rgba(64,255,64,0.75)");
    drawChannel(context, data.b, data.peak, "rgba(64,128,255,0.75)");
    context.globalCompositeOperation = "source-over";
  } else {
    drawChannel(context, data.luma, data.peak, "rgba(255,255,255,0.8)");
  }
}

watch([histogram, mode], ([data]) => draw(data), { flush: "post" });
onMounted(() => draw(histogram.value));
</script>

<template>
  <!--
    The scrim above is pointer-events-none so it never eats viewfinder input;
    this control opts itself back in.
  -->
  <div v-if="available" class="pointer-events-auto flex items-end gap-2">
    <UButton
      v-if="mode === 'off'"
      icon="i-lucide-chart-column"
      color="neutral"
      variant="ghost"
      size="xs"
      aria-label="Show histogram"
      title="Show histogram"
      @click="cycle"
    />

    <button
      v-else
      type="button"
      class="flex cursor-pointer flex-col items-end gap-1 rounded-md bg-black/40 p-1.5 transition-colors hover:bg-black/60"
      :aria-label="title"
      :title
      @click="cycle"
    >
      <div class="relative">
        <canvas
          ref="canvas"
          :style="{ width: `${WIDTH}px`, height: `${HEIGHT}px` }"
          class="block"
        />
        <!--
          Clipping rails. Red is spoken for in this interface — it means
          recording, and nothing else may wear it — so blown highlights are
          amber and crushed shadows are blue.
        -->
        <span
          v-show="clippedShadows"
          class="absolute inset-y-0 left-0 w-0.5 bg-sky-400"
          aria-hidden="true"
        />
        <span
          v-show="clippedHighlights"
          class="absolute inset-y-0 right-0 w-0.5 bg-amber-400"
          aria-hidden="true"
        />
      </div>
      <span class="font-mono text-[10px] leading-none tracking-wider text-white/50">{{
        label
      }}</span>
    </button>
  </div>
</template>
