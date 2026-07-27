<script setup lang="ts">
const {
  screen,
  component,
  preset,
  height = 520,
} = defineProps<{
  screen?: string;
  component?: string;
  preset?: string;
  height?: number;
}>();

const src = computed(() => {
  const base = useRuntimeConfig().app.baseURL;
  const path = `${base}demo${screen ? `/${screen}` : ""}`;
  // preset and component are read back by mock-transport.client.ts to seed
  // the mock; every prop must be consumed or oxlint fails on the unused one.
  const query = new URLSearchParams();
  if (preset) query.set("preset", preset);
  if (component) query.set("component", component);
  const suffix = query.size > 0 ? `?${query}` : "";
  return `${path}${suffix}`;
});
</script>

<template>
  <div class="my-8 overflow-hidden rounded-xl bg-default shadow-2xl ring-1 ring-default">
    <!-- macOS window chrome: traffic lights left, title centred, content below. -->
    <div class="relative flex h-9 items-center border-b border-default bg-elevated px-3.5">
      <div class="flex items-center gap-2">
        <span class="size-3 rounded-full bg-[#ff5f57]" />
        <span class="size-3 rounded-full bg-[#febc2e]" />
        <span class="size-3 rounded-full bg-[#28c840]" />
      </div>

      <span
        class="pointer-events-none absolute inset-x-0 text-center text-[13px] font-medium text-muted"
      >
        Luna Ultra Desktop — simulated camera
      </span>
    </div>

    <ClientOnly>
      <iframe
        :src
        :style="{ height: `${height}px` }"
        class="block w-full border-0 bg-default"
        loading="lazy"
        title="Luna Ultra Desktop demo"
      />
      <template #fallback>
        <div class="flex items-center justify-center" :style="{ height: `${height}px` }">
          <span class="text-sm text-muted">Loading demo…</span>
        </div>
      </template>
    </ClientOnly>
  </div>
</template>
