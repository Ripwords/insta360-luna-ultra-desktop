<script setup lang="ts">
import { useEventListener } from "@vueuse/core";
import { GIMBAL_RANGE } from "~/utils/gimbal";

/**
 * Pan and tilt by dragging anywhere on the picture.
 *
 * The stick is not parked in a corner, where it would sit on top of other
 * controls: it appears under the pointer once a drag starts and goes away on
 * release. The gimbal takes a speed on both axes at once, so a diagonal is one
 * gesture and a small push is a slow move. The response curve keeps the first
 * half of the travel gentle, because the moves you care about in a shot are
 * the small ones.
 *
 * A press that does not move is left alone, so a plain click on the picture
 * stays free for anything that wants it later (tap to track, tap to focus).
 *
 * The arrow keys drive the same vector (Shift for full speed), whenever focus
 * is not in a control that wants them for itself.
 */
const { ready, steer, release } = useGimbal();
const head = useHeadTracking();

/** Manual input wins over the headphones. */
function takeOver() {
  if (head.on.value) void head.stop();
}

/** Pointer travel, in px, that counts as full speed. */
const RADIUS = 48;
/** How far the knob drawing can travel from the centre of the ring, in px. */
const KNOB_TRAVEL = 32;
/** Pointer travel, in px, before a press becomes a drag. */
const DEADZONE = 6;
/** Exponent of the response curve: 1 is linear, higher is gentler near the centre. */
const CURVE = 1.6;
const shape = (n: number): number => Math.sign(n) * Math.abs(n) ** CURVE * GIMBAL_RANGE;

const layer = useTemplateRef("layer");
const pressed = ref(false);
const engaged = ref(false);
const origin = ref({ x: 0, y: 0 });
const knob = ref({ x: 0, y: 0 });

function local(event: PointerEvent) {
  const box = layer.value?.getBoundingClientRect();
  return box ? { x: event.clientX - box.left, y: event.clientY - box.top } : null;
}

function onDown(event: PointerEvent) {
  if (!ready.value || event.button !== 0) return;
  const at = local(event);
  if (!at) return;
  // Otherwise the drag starts a text selection across the viewfinder
  event.preventDefault();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  origin.value = at;
  pressed.value = true;
  engaged.value = false;
}

function onMove(event: PointerEvent) {
  if (!pressed.value) return;
  const at = local(event);
  if (!at) return;
  let dx = (at.x - origin.value.x) / RADIUS;
  let dy = (at.y - origin.value.y) / RADIUS;
  const length = Math.hypot(dx, dy);
  if (!engaged.value) {
    if (length * RADIUS < DEADZONE) return;
    engaged.value = true;
    takeOver();
  }
  if (length > 1) {
    dx /= length;
    dy /= length;
  }
  knob.value = { x: dx, y: dy };
  // Screen y grows downwards; tilt is positive looking up
  steer(shape(dx), shape(-dy));
}

function onUp() {
  if (!pressed.value) return;
  const wasEngaged = engaged.value;
  pressed.value = false;
  engaged.value = false;
  knob.value = { x: 0, y: 0 };
  if (wasEngaged) release();
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
  takeOver();
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
</script>

<template>
  <div
    v-if="ready"
    ref="layer"
    role="application"
    aria-label="Gimbal: drag on the picture to pan and tilt, or use the arrow keys"
    class="absolute inset-0 touch-none select-none"
    :class="engaged ? 'cursor-grabbing' : 'cursor-grab'"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
    @lostpointercapture="onUp"
  >
    <div
      v-if="engaged"
      class="pointer-events-none absolute size-24 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/50 bg-black/40 backdrop-blur-sm"
      :style="{ left: `${origin.x}px`, top: `${origin.y}px` }"
    >
      <span class="absolute inset-x-1/2 top-2 h-1.5 w-px bg-white/30" />
      <span class="absolute inset-x-1/2 bottom-2 h-1.5 w-px bg-white/30" />
      <span class="absolute inset-y-1/2 left-2 h-px w-1.5 bg-white/30" />
      <span class="absolute inset-y-1/2 right-2 h-px w-1.5 bg-white/30" />
      <span
        class="absolute left-1/2 top-1/2 size-8 rounded-full border border-white/60 bg-white/15 shadow"
        :style="{
          transform: `translate(calc(-50% + ${knob.x * KNOB_TRAVEL}px), calc(-50% + ${knob.y * KNOB_TRAVEL}px))`,
        }"
      />
    </div>
  </div>
</template>
