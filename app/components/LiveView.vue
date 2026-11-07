<script setup lang="ts">
import { AnnexBDecoder } from "~/utils/annexBDecoder";
import {
  computeHistogram,
  HISTOGRAM_SAMPLE_EVERY,
  HISTOGRAM_SAMPLE_HEIGHT,
  HISTOGRAM_SAMPLE_WIDTH,
} from "~/utils/histogram";

// The page owns starting and stopping the stream; this component is just the
// decoding surface for whatever the live-view composable is currently serving.
const { active, transport, streamUrl, error, note, stop } = useLiveView();

// A VideoFrame is only readable between decode and close, so the histogram is
// sampled here and pushed out, rather than the composable reaching in for it.
const { sampling, publish: publishHistogram } = useHistogram();

const canvas = useTemplateRef<HTMLCanvasElement>("canvas");

/** Offscreen scratch the frame is subsampled into before it is binned. */
let sampleCanvas: HTMLCanvasElement | null = null;
let sampleContext: CanvasRenderingContext2D | null = null;
let frameIndex = 0;

/**
 * Bin a decoded frame for the viewfinder histogram.
 *
 * The frame is drawn into a small scratch canvas with smoothing *off*. That
 * matters: scaling 1280x960 down with the browser's default smoothing averages
 * neighbouring pixels, so a blown highlight next to a mid-grey one lands near
 * 200 instead of 255 and the clipping you needed to see disappears. Nearest
 * neighbour takes real pixel values, and 128x96 of them is plenty of sample to
 * hold the shape of a scene.
 */
function sampleHistogram(frame: VideoFrame) {
  if (frameIndex++ % HISTOGRAM_SAMPLE_EVERY !== 0) return;

  if (!sampleCanvas) {
    sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = HISTOGRAM_SAMPLE_WIDTH;
    sampleCanvas.height = HISTOGRAM_SAMPLE_HEIGHT;
    sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (sampleContext) sampleContext.imageSmoothingEnabled = false;
  }
  if (!sampleContext) return;

  sampleContext.drawImage(frame, 0, 0, HISTOGRAM_SAMPLE_WIDTH, HISTOGRAM_SAMPLE_HEIGHT);
  const { data } = sampleContext.getImageData(
    0,
    0,
    HISTOGRAM_SAMPLE_WIDTH,
    HISTOGRAM_SAMPLE_HEIGHT,
  );
  publishHistogram(computeHistogram(data));
}
let abort: AbortController | null = null;

const player = new AnnexBDecoder({
  frame: paint,
  note,
  fatal: (message) => {
    error.value = message;
    note(message);
  },
});

function paint(frame: VideoFrame) {
  const element = canvas.value;
  if (!element) {
    frame.close();
    return;
  }
  if (element.width !== frame.displayWidth) element.width = frame.displayWidth;
  if (element.height !== frame.displayHeight) element.height = frame.displayHeight;
  element.getContext("2d")?.drawImage(frame, 0, 0);
  // Sample before closing: after this the frame's pixels are gone. Guarded so
  // a hidden histogram costs nothing at all.
  if (sampling.value) sampleHistogram(frame);
  frame.close();
}

async function consumeAnnexB(url: string) {
  abort = new AbortController();
  const response = await fetch(url, { signal: abort.signal });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("the local stream returned no body");

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value && !player.push(value)) return;
  }
}

function reset() {
  abort?.abort();
  abort = null;
  player.reset();
  frameIndex = 0;
}

watch([active, transport, streamUrl], async ([on, kind, url]) => {
  if (!on || kind !== "annexb" || !url) {
    reset();
    return;
  }
  reset();
  try {
    await consumeAnnexB(url);
  } catch (cause) {
    if ((cause as Error)?.name === "AbortError") return;
    error.value = cause instanceof Error ? cause.message : String(cause);
    note(`Stream read failed: ${error.value}`);
  }
});

onBeforeUnmount(() => {
  reset();
  void stop();
});
</script>

<template>
  <div class="size-full">
    <img
      v-if="active && transport === 'mjpeg' && streamUrl"
      :src="streamUrl"
      class="size-full object-contain"
    />
    <canvas
      v-show="active && transport === 'annexb'"
      ref="canvas"
      class="size-full object-contain"
    />
  </div>
</template>
