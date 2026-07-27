<script setup lang="ts">
const {
  screen,
  preset,
  height = 520,
} = defineProps<{
  screen?: string;
  preset?: string;
  height?: number;
}>();

const src = computed(() => {
  const base = useRuntimeConfig().app.baseURL;
  const path = `${base}demo${screen ? `/${screen}` : ""}`;
  // preset is read back by mock-transport.client.ts to seed the mock.
  const query = new URLSearchParams();
  if (preset) query.set("preset", preset);
  const suffix = query.size > 0 ? `?${query}` : "";
  return `${path}${suffix}`;
});
</script>

<template>
  <div class="my-8 overflow-hidden rounded-[11px] bg-default shadow-2xl ring-1 ring-default">
    <!--
      macOS window chrome: traffic lights left, title centred, content below.
      `rounded-xl` (24px under the Nuxt UI radius token) read as a rounded
      card rather than OS chrome — real macOS windows are ~10-12px, so this
      is hardcoded rather than tokenised.

      The hairline below is hardcoded too: Nuxt UI maps both `--ui-border`
      and `--ui-bg-elevated` to the same `neutral-800` in dark mode, so
      `border-default` on a `bg-elevated` title bar has zero contrast there —
      no visible seam at all, which defeats the point of drawing OS chrome.
      A translucent black/white line reads as a seam against any surface in
      either theme, which a themed border token can't guarantee.
    -->
    <div
      class="relative flex h-9 items-center border-b border-black/10 bg-elevated px-3.5 dark:border-white/10"
    >
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
