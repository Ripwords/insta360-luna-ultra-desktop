<script setup lang="ts">
import { buildCodecString, detectCodec, drainAccessUnits, splitNalUnits } from "~/utils/annexB";
import type { NalCodec } from "~/utils/annexB";

// The page owns starting and stopping the stream; this component is just the
// decoding surface for whatever the live-view composable is currently serving.
const { active, transport, streamUrl, error, note, stop } = useLiveView();

const canvas = useTemplateRef<HTMLCanvasElement>("canvas");
let decoder: VideoDecoder | null = null;
let abort: AbortController | null = null;

/** Bytes that arrived mid-NAL and must be prepended to the next chunk. */
let carry = new Uint8Array(0);
/** Complete NAL units not yet proven to form a finished picture. */
let pendingUnits: Uint8Array[] = [];
let codec: NalCodec | null = null;
let configured = false;
let seenKeyframe = false;
let timestamp = 0;

function paint(frame: VideoFrame) {
  const element = canvas.value;
  if (!element) {
    frame.close();
    return;
  }
  if (element.width !== frame.displayWidth) element.width = frame.displayWidth;
  if (element.height !== frame.displayHeight) element.height = frame.displayHeight;
  element.getContext("2d")?.drawImage(frame, 0, 0);
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
    if (!value) continue;

    const merged = new Uint8Array(carry.length + value.length);
    merged.set(carry);
    merged.set(value, carry.length);

    const units = splitNalUnits(merged);
    if (units.length === 0) {
      carry = merged;
      continue;
    }
    // The last unit may be cut mid-NAL; hold its bytes back for the next read.
    const tail = units.at(-1)!;
    carry = new Uint8Array(4 + tail.length);
    carry.set([0, 0, 0, 1]);
    carry.set(tail, 4);
    // Copy, so these views do not pin the whole merged buffer in memory
    for (const unit of units.slice(0, -1)) pendingUnits.push(unit.slice());
    if (pendingUnits.length === 0) continue;

    codec ??= detectCodec(pendingUnits);
    if (!codec) continue;

    if (!configured) {
      const codecString = buildCodecString(pendingUnits, codec);
      if (!codecString) continue;
      note(`Detected ${codec}, codec string ${codecString}.`);
      decoder = new VideoDecoder({
        output: paint,
        error: (cause) => {
          // A decode error — a garbled or dropped frame after a while, or an
          // HEVC frame the platform choked on — used to abort the whole stream
          // and end the preview for good. Instead drop just the decode pipeline
          // and keep reading: the loop reconfigures a fresh decoder from the
          // next keyframe, so a glitch is a brief blip rather than the end.
          note(`Decoder error, resyncing at next keyframe: ${cause.message}`);
          resetDecoderState();
        },
      });
      try {
        decoder.configure({ codec: codecString, optimizeForLatency: true });
      } catch (cause) {
        error.value = `VideoDecoder rejected "${codecString}": ${
          cause instanceof Error ? cause.message : String(cause)
        }`;
        note(error.value);
        return;
      }
      configured = true;
    }

    const { access, pending } = drainAccessUnits(pendingUnits, codec);
    pendingUnits = pending;

    for (const unit of access) {
      // The decoder may have just been reset (e.g. after an error). Stop
      // feeding this batch and let the next keyframe reconfigure it, rather
      // than ending the read loop.
      if (decoder?.state !== "configured") break;
      // Feeding delta frames before the first keyframe guarantees a failure
      if (!unit.key && !seenKeyframe) continue;
      if (unit.key) seenKeyframe = true;
      decoder.decode(
        new EncodedVideoChunk({
          type: unit.key ? "key" : "delta",
          timestamp: timestamp,
          data: unit.data,
        }),
      );
      timestamp += 33333; // ~30fps in microseconds
    }
  }
}

function reset() {
  abort?.abort();
  abort = null;
  resetDecoderState();
  carry = new Uint8Array(0);
  timestamp = 0;
}

/**
 * Tear down only the decode pipeline, leaving the fetch running. This is what
 * lets a decoder error recover: the read loop keeps pulling bytes and builds a
 * fresh decoder from the next keyframe's parameter sets. `carry` and
 * `timestamp` are deliberately left intact so timestamps never jump backwards.
 */
function resetDecoderState() {
  try {
    decoder?.close();
  } catch {
    // Already closed; nothing to do
  }
  decoder = null;
  pendingUnits = [];
  codec = null;
  configured = false;
  seenKeyframe = false;
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
