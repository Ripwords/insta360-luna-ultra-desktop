<script setup lang="ts">
defineProps<{ collapsed?: boolean }>();

const { status, info } = useCamera();
const { enabled: webcamOn } = useWebcam();

const meta = computed(() => {
  switch (status.value) {
    case "connected":
      return { label: "Connected", icon: "i-lucide-wifi", color: "success" as const };
    case "connecting":
      return {
        label: "Pairing",
        icon: "i-lucide-loader-circle",
        color: "neutral" as const,
        spin: true,
      };
    default:
      return { label: "Offline", icon: "i-lucide-wifi-off", color: "neutral" as const };
  }
});

const tooltip = computed(() =>
  info.value ? (info.value.ssid ?? info.value.host) : "Camera not connected",
);
</script>

<template>
  <div class="flex gap-1.5" :class="collapsed ? 'flex-col items-center' : 'w-full items-center'">
    <UTooltip :text="tooltip">
      <NuxtLink
        to="/settings"
        class="block rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        :class="collapsed ? '' : 'min-w-0 flex-1'"
        :aria-label="`Camera ${meta.label.toLowerCase()}. Open settings`"
      >
        <UBadge
          :color="meta.color"
          variant="subtle"
          size="md"
          :class="collapsed ? 'px-1.5' : 'w-full justify-start'"
        >
          <UIcon
            :name="meta.icon"
            class="size-3.5 shrink-0"
            :class="meta.spin ? 'animate-spin' : ''"
          />
          <span v-if="!collapsed">{{ meta.label }}</span>
        </UBadge>
      </NuxtLink>
    </UTooltip>
    <!-- A user on another page should know the camera is busy streaming. -->
    <UTooltip v-if="webcamOn" text="Webcam mode on">
      <NuxtLink
        to="/camera"
        class="block shrink-0 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        aria-label="Webcam mode on. Open camera"
      >
        <UBadge color="primary" variant="subtle" size="md" class="px-1.5">
          <UIcon name="i-lucide-webcam" class="size-3.5 shrink-0" />
        </UBadge>
      </NuxtLink>
    </UTooltip>
  </div>
</template>
