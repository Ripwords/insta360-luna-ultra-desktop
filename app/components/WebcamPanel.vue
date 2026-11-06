<script setup lang="ts">
import { useClipboard } from "@vueuse/core";

const SETUP_GUIDE_URL = "https://ripwords.github.io/insta360-luna-ultra-desktop/docs/webcam";
const STALL_MESSAGE =
  "The camera stopped sending video. Its screen may have gone to sleep. Tap the camera's screen to wake it.";

const { enabled, status, error, turnOn, turnOff } = useWebcam();
const { copy, copied } = useClipboard({ copiedDuring: 1500 });

/** True while a turn-on or turn-off call is in flight, so the switch can't be double-flipped. */
const pending = ref(false);

async function toggle(value: boolean) {
  pending.value = true;
  try {
    await (value ? turnOn() : turnOff());
  } finally {
    pending.value = false;
  }
}

const url = computed(() => status.value?.url ?? "");

const line = computed(() => {
  const current = status.value;
  switch (current?.state) {
    case "streaming": {
      const size = current.width && current.height ? ` · ${current.width}×${current.height}` : "";
      return { text: `Streaming${size}`, icon: "i-lucide-radio", tone: "text-success" };
    }
    case "stalled":
      return { text: STALL_MESSAGE, icon: "i-lucide-triangle-alert", tone: "text-warning" };
    case "stopped":
      return { text: "Camera disconnected", icon: "i-lucide-wifi-off", tone: "text-muted" };
    default:
      return {
        text: "Waiting for camera",
        icon: "i-lucide-loader-circle",
        tone: "text-muted",
        spin: true,
      };
  }
});
</script>

<template>
  <section
    class="flex flex-col gap-3 rounded-[18px] border border-default bg-elevated/40 p-3"
    aria-label="Webcam mode"
  >
    <div class="flex items-center justify-between gap-4">
      <USwitch
        :model-value="enabled"
        :loading="pending"
        :disabled="pending"
        size="md"
        label="Webcam mode"
        description="Stream the preview to OBS."
        @update:model-value="toggle"
      />
      <ULink
        v-if="enabled"
        :to="SETUP_GUIDE_URL"
        target="_blank"
        class="flex shrink-0 items-center gap-1 text-sm"
      >
        Set up OBS
        <UIcon name="i-lucide-arrow-up-right" class="size-4" />
      </ULink>
    </div>

    <p v-if="error" class="text-sm text-error">{{ error }}</p>

    <template v-if="enabled">
      <UFieldGroup v-if="url" class="w-full">
        <UInput
          :model-value="url"
          readonly
          size="md"
          aria-label="Stream address"
          class="min-w-0 flex-1"
          :ui="{ base: 'font-mono' }"
        />
        <UButton
          :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
          :label="copied ? 'Copied' : 'Copy'"
          color="neutral"
          variant="outline"
          size="md"
          @click="copy(url)"
        />
      </UFieldGroup>

      <p class="flex items-start gap-2 text-sm" :class="line.tone" role="status">
        <UIcon
          :name="line.icon"
          class="mt-0.5 size-4 shrink-0"
          :class="line.spin ? 'animate-spin' : ''"
        />
        <span>{{ line.text }}</span>
      </p>
    </template>
  </section>
</template>
