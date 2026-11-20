<script setup lang="ts">
/**
 * The gimbal's one-shot buttons, down the left edge of the viewfinder,
 * mirroring the zoom dial on the right: recenter, flip, and on a Mac the
 * AirPods head tracking toggle. Steering itself is a drag on the picture
 * (CameraGimbalStick), so nothing here sits in the way of the pro bar.
 */
const { ready, error, recenter, flip } = useGimbal();
const head = useHeadTracking();
onMounted(() => void head.refreshSupport());

function onRecenter() {
  if (head.on.value) void head.recenter();
  else void recenter();
}

const note = computed(() => {
  if (head.error.value) return { text: head.error.value, warn: true };
  if (error.value) return { text: error.value, warn: true };
  if (head.state.value === "starting") return { text: "Starting head tracking…", warn: false };
  if (head.state.value === "waiting")
    return {
      text: "Waiting for your AirPods. Wear both, and pick a microphone other than the AirPods.",
      warn: false,
    };
  return null;
});
</script>

<template>
  <div v-if="ready" class="flex items-center gap-2">
    <!-- Outer radius = button radius (6 px) + padding (4 px) -->
    <div class="flex flex-col gap-1 rounded-[10px] bg-black/50 p-1 backdrop-blur-md">
      <UTooltip
        :text="head.on.value ? 'Recenter on where you are looking' : 'Recenter'"
        :content="{ side: 'right' }"
      >
        <UButton
          icon="i-lucide-crosshair"
          color="neutral"
          variant="ghost"
          class="text-white/70 hover:text-white"
          :aria-label="
            head.on.value ? 'Recenter the gimbal on where you are looking' : 'Recenter the gimbal'
          "
          @click="onRecenter"
        />
      </UTooltip>
      <UTooltip text="Flip front / selfie" :content="{ side: 'right' }">
        <UButton
          icon="i-lucide-switch-camera"
          color="neutral"
          variant="ghost"
          class="text-white/70 hover:text-white"
          aria-label="Flip between front and selfie"
          @click="flip"
        />
      </UTooltip>
      <UTooltip
        v-if="head.supported.value"
        :text="head.on.value ? 'Stop following your AirPods' : 'Follow your head with AirPods'"
        :content="{ side: 'right' }"
      >
        <UButton
          icon="i-lucide-headphones"
          color="neutral"
          :variant="head.on.value ? 'solid' : 'ghost'"
          :class="head.on.value ? '' : 'text-white/70 hover:text-white'"
          :aria-label="
            head.on.value ? 'Stop following your AirPods' : 'Follow your head with AirPods'
          "
          :aria-pressed="head.on.value"
          @click="head.toggle"
        />
      </UTooltip>
    </div>

    <span
      v-if="note"
      class="max-w-56 rounded-lg bg-black/60 px-2 py-1 text-sm backdrop-blur-md"
      :class="note.warn ? 'text-warning' : 'text-white/80'"
      >{{ note.text }}</span
    >
  </div>
</template>
