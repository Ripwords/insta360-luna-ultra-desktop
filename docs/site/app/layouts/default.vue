<script setup lang="ts">
import type { ContentNavigationItem } from "@nuxt/content";

const { data: navigation } = await useAsyncData("docs-navigation", () =>
  queryCollectionNavigation("docs"),
);

const links = [
  { label: "Docs", to: "/docs/install" },
  { label: "Contributing", to: "/docs/contributing" },
  { label: "Demo", to: "/demo" },
  {
    label: "GitHub",
    to: "https://github.com/Ripwords/insta360-luna-ultra-desktop",
    target: "_blank",
    icon: "i-simple-icons-github",
  },
];
</script>

<template>
  <UHeader>
    <template #title>
      <span class="flex items-center gap-2.5">
        <span class="flex size-8 items-center justify-center rounded-lg bg-inverted">
          <UIcon name="i-lucide-moon" class="size-4.5 text-inverted" />
        </span>
        <span class="font-semibold tracking-tight">Luna Ultra Desktop</span>
      </span>
    </template>

    <UNavigationMenu :items="links" variant="link" />

    <template #body>
      <UNavigationMenu :items="links" orientation="vertical" />
    </template>
  </UHeader>

  <UMain>
    <UContainer>
      <UPage>
        <template #left>
          <UPageAside>
            <UContentNavigation
              :navigation="(navigation as ContentNavigationItem[] | undefined) ?? []"
              highlight
            />
          </UPageAside>
        </template>

        <slot />
      </UPage>
    </UContainer>
  </UMain>

  <UFooter>
    <template #left>
      <span class="text-sm text-muted">
        Unofficial companion app. Insta360 and Luna Ultra are trademarks of their respective owners.
      </span>
    </template>
  </UFooter>
</template>
