<script setup lang="ts">
import { useEventListener } from "@vueuse/core";
import { GIMBAL_RANGE } from "~/utils/gimbal";

/**
 * Pan and tilt, at the lower left of the viewfinder.
 *
 * A pad rather than four arrows: the gimbal takes a speed on both axes at
 * once, so a diagonal is one gesture and a small push is a slow move. The
 * response curve keeps the first half of the travel gentle, because the
 * moves you care about in a shot are the small ones.
 *
 * The arrow keys drive the same vector (Shift for full speed), whenever focus
 * is not in a control that wants them for itself.
 */
const { vector, ready, error, steer, release, recenter, flip } = useGimbal();

const pad = useTemplateRef("pad");
const dragging = ref(false);
const knob = ref({ x: 0, y: 0 });

/** Exponent of the response curve: 1 is linear, higher is gentler near the centre. */
const CURVE = 1.6;
const shape = (n: number): number => Math.sign(n) * Math.abs(n) ** CURVE * GIMBAL_RANGE;

function aim(event: PointerEvent) {
  const box = pad.value?.getBoundingClientRect();
  if (!box) return;
  const radius = box.width / 2;
  let dx = (event.clientX - (box.left + radius)) / radius;
  let dy = (event.clientY - (box.top + radius)) / radius;
  const length = Math.hypot(dx, dy);
  if (length > 1) {
    dx /= length;
    dy /= length;
  }
  knob.value = { x: dx, y: dy };
  // Screen y grows downwards; tilt is positive looking up
  steer(shape(dx), shape(-dy));
}

function onDown(event: PointerEvent) {
  if (!ready.value) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  dragging.value = true;
  aim(event);
}

function onMove(event: PointerEvent) {
  if (dragging.value) aim(event);
}

function onUp() {
  if (!dragging.value) return;
  dragging.value = false;
  knob.value = { x: 0, y: 0 };
  release();
}

const KEY_SPEED = 45;
const held = new Set<string>();
let fast = false;

function fromKeys() {
  const speed = fast ? GIMBAL_RANGE : KEY_SPEED;
  const pan = (held.has("ArrowRight") ? 1 : 0) - (held.has("ArrowLeft") ? 1 : 0);
  const tilt = (held.has("ArrowUp") ? 1 : 0) - (held.has("ArrowDown") ? 1 : 0);
  if (pan === 0 && tilt === 0) release();
  else steer(pan * speed, tilt * speed);
}

/** Text fields, selects and sliders (the zoom dial) keep their arrow keys. */
function ownsArrows(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return true;
  return target.closest('[role="slider"], [role="listbox"], [role="menu"]') !== null;
}

function onKeyDown(event: KeyboardEvent) {
  if (!event.key.startsWith("Arrow") || !ready.value || ownsArrows(event.target)) return;
  event.preventDefault();
  fast = event.shiftKey;
  if (held.has(event.key) && !event.repeat) return;
  held.add(event.key);
  fromKeys();
}

function onKeyUp(event: KeyboardEvent) {
  if (!held.delete(event.key)) return;
  fast = event.shiftKey;
  fromKeys();
}

function letGoOfKeys() {
  if (held.size === 0) return;
  held.clear();
  release();
}

useEventListener(window, "keydown", onKeyDown);
useEventListener(window, "keyup", onKeyUp);
// A key released while the window is in the background never sends keyup
useEventListener(window, "blur", letGoOfKeys);
onBeforeUnmount(() => {
  letGoOfKeys();
  release();
});

const moving = computed(() => vector.value.pan !== 0 || vector.value.tilt !== 0);
</script>

<template>
  <div v-if="ready" class="flex flex-col items-center gap-2">
    <div
      ref="pad"
      role="application"
      aria-label="Gimbal: drag to pan and tilt, or use the arrow keys"
      class="relative size-24 touch-none select-none rounded-full border border-white/20 bg-black/35 backdrop-blur-sm transition-colors"
      :class="dragging || moving ? 'border-white/50 bg-black/50' : 'hover:border-white/35'"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @lostpointercapture="onUp"
    >
      <span class="pointer-events-none absolute inset-x-1/2 top-2 h-1.5 w-px bg-white/30" />
      <span class="pointer-events-none absolute inset-x-1/2 bottom-2 h-1.5 w-px bg-white/30" />
      <span class="pointer-events-none absolute inset-y-1/2 left-2 h-px w-1.5 bg-white/30" />
      <span class="pointer-events-none absolute inset-y-1/2 right-2 h-px w-1.5 bg-white/30" />
      <span
        class="pointer-events-none absolute left-1/2 top-1/2 size-8 rounded-full border border-white/60 bg-white/15 shadow"
        :class="dragging ? '' : 'transition-transform duration-150'"
        :style="{
          transform: `translate(calc(-50% + ${knob.x * 32}px), calc(-50% + ${knob.y * 32}px))`,
        }"
      />
    </div>

    <div class="flex items-center gap-1">
      <UButton
        icon="i-lucide-crosshair"
        size="xs"
        color="neutral"
        variant="ghost"
        class="text-white/70 hover:text-white"
        aria-label="Recenter the gimbal"
        @click="recenter"
      />
      <UButton
        icon="i-lucide-switch-camera"
        size="xs"
        color="neutral"
        variant="ghost"
        class="text-white/70 hover:text-white"
        aria-label="Flip between front and selfie"
        @click="flip"
      />
    </div>

    <span v-if="error" class="max-w-32 text-center font-mono text-[10px] text-warning">{{
      error
    }}</span>
  </div>
</template>
