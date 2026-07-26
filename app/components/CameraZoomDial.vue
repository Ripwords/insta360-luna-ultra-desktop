<script setup lang="ts">
import { ZOOM_MARKS, ZOOM_MAX, ZOOM_MIN, zoomFraction, zoomLabel } from "~/utils/cameraLabels";

/**
 * The zoom dial, down the right of the viewfinder.
 *
 * At rest it is just the current value and a short needle. The tick scale only
 * appears while you are actually zooming — a permanent ruler over the picture is
 * a lab instrument bolted to a viewfinder, competing with the shot for no
 * benefit, since the number only matters while it is changing.
 *
 * Scrolling over the picture is still the primary control. This shows where you
 * are, offers the marked stops as one-click targets, and can be dragged.
 */
const { zoom, fraction, busy, active, wake, hold, nudgeBy, jumpTo, commit } = useCameraZoom();

const track = useTemplateRef("track");
const dragging = ref(false);
let lastY = 0;

function onDown(event: PointerEvent) {
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  dragging.value = true;
  hold();
  lastY = event.clientY;
}

function onMove(event: PointerEvent) {
  if (!dragging.value) return;
  const height = track.value?.getBoundingClientRect().height ?? 1;
  nudgeBy((lastY - event.clientY) / height);
  lastY = event.clientY;
}

function onUp() {
  if (!dragging.value) return;
  dragging.value = false;
  commit();
}

function onKey(event: KeyboardEvent) {
  const step = event.key === "ArrowUp" ? 0.04 : event.key === "ArrowDown" ? -0.04 : 0;
  if (!step) return;
  event.preventDefault();
  nudgeBy(step);
  commit();
}

/** Ticks are dense enough to read as a scale, sparse enough not to shimmer. */
const TICKS = Array.from({ length: 25 }, (_, i) => i / 24);
const isMarked = (at: number) =>
  ZOOM_MARKS.some((mark) => Math.abs(zoomFraction(mark) - at) < 0.02);
const marks = computed(() => ZOOM_MARKS.map((mark) => ({ mark, at: zoomFraction(mark) })));
</script>

<template>
  <div
    ref="track"
    role="slider"
    tabindex="0"
    aria-label="Zoom"
    :aria-valuemin="ZOOM_MIN"
    :aria-valuemax="ZOOM_MAX"
    :aria-valuenow="zoom"
    :aria-valuetext="zoomLabel(zoom)"
    class="relative h-2/3 w-12 cursor-ns-resize touch-none select-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/60"
    :class="busy ? 'opacity-60' : ''"
    @pointerenter="wake(2000)"
    @pointerdown.prevent="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
    @keydown="onKey"
    @focus="wake(3000)"
  >
    <!--
      Everything except the needle and the value fades out when idle. Kept
      mounted rather than removed so the drag target never moves under you.
    -->
    <div
      class="absolute inset-0 transition-opacity duration-300"
      :class="active ? 'opacity-100' : 'opacity-0'"
    >
      <span
        v-for="at in TICKS"
        :key="at"
        class="pointer-events-none absolute right-0 h-px"
        :class="isMarked(at) ? 'w-3 bg-white/70' : 'w-1.5 bg-white/30'"
        :style="{ top: `${(1 - at) * 100}%` }"
      />

      <button
        v-for="{ mark, at } in marks"
        :key="`mark-${mark}`"
        type="button"
        class="absolute right-4 -translate-y-1/2 rounded px-1 text-[10px] tabular-nums text-white/60 transition-colors hover:text-white focus-visible:outline-1 focus-visible:outline-white"
        :style="{ top: `${(1 - at) * 100}%` }"
        :aria-label="`Zoom to ${mark}x`"
        @pointerdown.stop
        @click.stop="jumpTo(mark)"
      >
        {{ mark }}
      </button>
    </div>

    <!-- The needle and the value stay, because where you are is always worth knowing -->
    <span
      class="pointer-events-none absolute right-0 h-0.5 w-4 -translate-y-1/2 rounded-full bg-amber-400 transition-[top] duration-100"
      :style="{ top: `${(1 - fraction) * 100}%` }"
    />
    <span
      class="pointer-events-none absolute right-5 -translate-y-1/2 whitespace-nowrap font-mono text-xs font-semibold tabular-nums text-amber-400 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)] transition-[top] duration-100"
      :style="{ top: `${(1 - fraction) * 100}%` }"
    >
      {{ zoomLabel(zoom) }}
    </span>
  </div>
</template>
