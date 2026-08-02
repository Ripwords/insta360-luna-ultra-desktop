<script setup lang="ts">
import { WATERMARK_POSITIONS, type WatermarkPosition } from "~/utils/watermark";

const {
  note = "The official watermark is rendered into JPEG photos. RAW files and videos transfer untouched.",
} = defineProps<{ previewSrc?: string; note?: string }>();

const { settings } = useWatermarkSettings();

const positionLabels: Record<WatermarkPosition, string> = {
  "top-left": "Top left",
  "top-right": "Top right",
  "bottom-left": "Bottom left",
  "bottom-center": "Bottom center",
  "bottom-right": "Bottom right",
};

const anchorClasses: Record<WatermarkPosition, string> = {
  "top-left": "left-2 top-2",
  "top-right": "right-2 top-2",
  "bottom-left": "bottom-2 left-2",
  "bottom-center": "bottom-2 left-1/2 -translate-x-1/2",
  "bottom-right": "bottom-2 right-2",
};
</script>

<template>
  <div class="space-y-5">
    <USwitch v-model="settings.enabled" label="Apply Luna Ultra watermark" :description="note" />

    <div v-if="settings.enabled" class="grid grid-cols-[1fr_auto] items-start gap-4">
      <WatermarkCanvas :src="previewSrc" />
      <UFormField label="Position" :help="positionLabels[settings.position]">
        <div class="relative h-20 w-32 rounded-lg border border-default bg-muted">
          <button
            v-for="position in WATERMARK_POSITIONS"
            :key="position"
            type="button"
            class="absolute flex size-6 cursor-pointer items-center justify-center rounded-md border transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            :class="[
              anchorClasses[position],
              settings.position === position
                ? 'border-transparent bg-primary text-inverted'
                : 'border-default bg-elevated text-muted hover:border-accented hover:text-default',
            ]"
            :aria-label="positionLabels[position]"
            :aria-pressed="settings.position === position"
            @click="settings.position = position"
          >
            <span class="block size-1.5 rounded-[2px] bg-current" />
          </button>
        </div>
      </UFormField>
    </div>
  </div>
</template>
