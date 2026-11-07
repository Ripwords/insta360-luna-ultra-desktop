<script setup lang="ts">
/**
 * Stands in for camera media while webcam mode holds the camera. Static on
 * purpose: nothing is loading, so a spinner would promise progress that
 * never comes.
 */
const { detailed = false, onDark = false } = defineProps<{
  /** Large views (preview, watermark sample) also say why. */
  detailed?: boolean;
  /** On the black preview stage, where the theme's muted grey falls short of AA. */
  onDark?: boolean;
}>();

const LABEL = "Paused while webcam mode is on";
</script>

<template>
  <div
    role="img"
    :aria-label="LABEL"
    class="flex size-full flex-col items-center justify-center gap-2 text-center"
    :class="onDark ? 'text-neutral-300' : 'text-dimmed'"
  >
    <UIcon name="i-lucide-circle-pause" :class="detailed ? 'size-8' : 'size-5'" />
    <p v-if="detailed" class="text-sm" :class="onDark ? '' : 'text-muted'">{{ LABEL }}.</p>
  </div>
</template>
