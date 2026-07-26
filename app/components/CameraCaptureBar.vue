<script setup lang="ts">
/**
 * Mode strip plus the shutter, mirroring the phone app's bottom bar. The
 * button's shape follows the mode: a red disc that becomes a stop square
 * while recording, or a plain shutter for stills.
 */
const { modes, modeId, isPhoto, recording, elapsedLabel, busy, error, selectMode, trigger } =
  useCameraCapture();
</script>

<template>
  <div class="space-y-2">
    <div class="flex justify-center gap-1 overflow-x-auto">
      <button
        v-for="mode in modes"
        :key="mode.id"
        type="button"
        class="shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors"
        :class="
          mode.id === modeId ? 'font-semibold text-primary' : 'text-muted hover:text-highlighted'
        "
        :disabled="busy"
        @click="selectMode(mode.id)"
      >
        {{ mode.label }}
      </button>
    </div>

    <div class="flex items-center justify-center gap-6">
      <span
        class="w-16 text-right font-mono text-sm"
        :class="recording ? 'text-error' : 'text-dimmed'"
      >
        {{ recording ? elapsedLabel : "" }}
      </span>

      <button
        type="button"
        class="flex size-16 items-center justify-center rounded-full border-4 border-default transition-transform active:scale-95 disabled:opacity-50"
        :aria-label="isPhoto ? 'Take photo' : recording ? 'Stop recording' : 'Start recording'"
        :disabled="busy"
        @click="trigger"
      >
        <span
          class="bg-error transition-all"
          :class="
            isPhoto
              ? 'size-11 rounded-full bg-white'
              : recording
                ? 'size-6 rounded-sm'
                : 'size-11 rounded-full'
          "
        />
      </button>

      <span class="w-16 text-left text-xs text-dimmed">
        <UIcon v-if="busy" name="i-lucide-loader-circle" class="animate-spin" />
      </span>
    </div>

    <UAlert
      v-if="error"
      icon="i-lucide-triangle-alert"
      color="warning"
      variant="subtle"
      :title="error"
    />
  </div>
</template>
