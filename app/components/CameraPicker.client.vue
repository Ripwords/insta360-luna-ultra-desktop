<script setup lang="ts">
import type { WheelStep } from "~/utils/cameraLabels";

/**
 * The list that drops out of a pro-bar chip.
 *
 * Vertical and sized to its contents, anchored over the chip that opened it.
 * The horizontal strip this replaced spanned the whole window whatever it held,
 * so choosing between "16:9" and "2.35:1" took the full width of the app and
 * the options sat nowhere near the control you pressed.
 *
 * Choosing closes it. These are all single choices, and leaving the list open
 * over the picture after a decision is made just hides the thing you are
 * setting up.
 */
defineProps<{
  steps: WheelStep[];
  modelValue: string | undefined;
  busy?: boolean;
}>();

const emit = defineEmits<{ select: [value: string]; dismiss: [] }>();

const list = ref<HTMLElement | null>(null);

// Long lists (shutter has 49 stops) open scrolled somewhere arbitrary otherwise
onMounted(async () => {
  await nextTick();
  list.value
    ?.querySelector<HTMLElement>("[data-selected='true']")
    ?.scrollIntoView({ block: "center" });
});

/** Escape closes without choosing, as it should anywhere. */
const onKey = (event: KeyboardEvent) => event.key === "Escape" && emit("dismiss");
</script>

<template>
  <!--
    Two boxes, deliberately. The blur belongs on a box that never moves: when it
    was on the scrolling element the browser had to recompute it against the
    content sliding underneath, every frame, and the list dragged. The shell
    stays put and only the plain box inside it scrolls.
  -->
  <div
    class="absolute bottom-full left-1/2 z-30 mb-2 w-max min-w-full -translate-x-1/2 overflow-hidden rounded-xl bg-black/85 shadow-xl ring-1 ring-white/10 backdrop-blur-md"
    :class="busy ? 'pointer-events-none opacity-60' : ''"
  >
    <div
      ref="list"
      class="max-h-72 overflow-y-auto overscroll-contain p-1 [scrollbar-width:thin]"
      role="listbox"
      tabindex="-1"
      @keydown="onKey"
    >
      <button
        v-for="step in steps"
        :key="step.value"
        type="button"
        role="option"
        :data-selected="step.value === modelValue"
        :aria-selected="step.value === modelValue"
        class="block w-full rounded-lg px-3 py-1.5 text-center text-sm tabular-nums focus-visible:outline-1 focus-visible:outline-white"
        :class="
          step.value === modelValue
            ? 'bg-white/20 font-medium text-white'
            : 'text-white/70 hover:bg-white/10 hover:text-white'
        "
        @click="emit('select', step.value)"
      >
        {{ step.label }}
      </button>
    </div>
  </div>
</template>
