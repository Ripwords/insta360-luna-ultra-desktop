<script setup lang="ts">
import type { NavigationMenuItem } from "@nuxt/ui";

const { active } = useDownloads();
const route = useRoute();

const items = computed<NavigationMenuItem[][]>(() => [
  [
    {
      label: "Connect",
      icon: "i-lucide-cable",
      to: "/",
      active: route.path === "/",
    },
    {
      label: "Camera",
      icon: "i-lucide-camera",
      to: "/camera",
    },
    {
      label: "Gallery",
      icon: "i-lucide-images",
      to: "/gallery",
    },
    {
      label: "Downloads",
      icon: "i-lucide-arrow-down-to-line",
      to: "/downloads",
      badge: active.value.length > 0 ? String(active.value.length) : undefined,
    },
  ],
  [
    {
      label: "Settings",
      icon: "i-lucide-settings",
      to: "/settings",
    },
  ],
]);
</script>

<template>
  <UDashboardGroup storage="local" storage-key="luna-dashboard">
    <UDashboardSidebar collapsible resizable :min-size="12" :default-size="16" :max-size="20">
      <template #header="{ collapsed }">
        <NuxtLink
          to="/"
          class="flex items-center gap-2.5 overflow-hidden"
          aria-label="Luna Ultra home"
        >
          <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-inverted">
            <UIcon name="i-lucide-moon" class="size-4.5 text-inverted" />
          </span>
          <span
            v-if="!collapsed"
            class="truncate text-sm font-semibold tracking-tight text-highlighted"
          >
            Luna Ultra
          </span>
        </NuxtLink>
      </template>

      <template #default="{ collapsed }">
        <UNavigationMenu :collapsed :items orientation="vertical" class="mt-2" />
      </template>

      <template #footer="{ collapsed }">
        <div class="flex w-full flex-col gap-3" :class="collapsed ? 'items-center' : ''">
          <UpdateBanner :collapsed />
          <CameraStatusChip :collapsed />
        </div>
      </template>
    </UDashboardSidebar>

    <slot />
  </UDashboardGroup>
</template>
