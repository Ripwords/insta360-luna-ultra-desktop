<script setup lang="ts">
import type { ContentNavigationItem } from "@nuxt/content";

const { data: navigation } = await useAsyncData("docs-navigation", () =>
  queryCollectionNavigation("docs"),
);

/**
 * Search is deferred until someone actually opens it, and this matters more
 * than it looks. Resolving a content query on a statically-hosted site means
 * Nuxt Content spins up its client-side SQLite: measured on this build, an
 * 800 KB `sqlite3.wasm` plus the 21 KB gzipped index dump. `server: false`
 * alone keeps that out of the prerendered HTML, but `useLazyAsyncData` still
 * fires on mount, so every docs page would pay ~820 KB post-hydration for a
 * feature most visitors never touch — on a site whose entire purpose is
 * ranking prose.
 *
 * `immediate: false` plus the watcher below ties the cost to intent: nothing
 * loads until the user opens search (button or Cmd/Ctrl+K), and `status` makes
 * that one-off load legible rather than looking like a broken empty result.
 */
const { open: searchOpen } = useContentSearch();
const {
  data: searchFiles,
  status: searchStatus,
  execute: loadSearchIndex,
} = useLazyAsyncData("docs-search", () => queryCollectionSearchSections("docs"), {
  server: false,
  immediate: false,
});

watch(searchOpen, (isOpen) => {
  if (isOpen && searchStatus.value === "idle") void loadSearchIndex();
});

const baseURL = useRuntimeConfig().app.baseURL;

/**
 * Nav labels double as the site's IA and are referenced by search engines and
 * muscle memory alike; they are deliberately unchanged from the original set.
 * GitHub moved out of this list into an icon button on the right, because
 * `UHeader`'s centre region is only genuinely centred when the left and right
 * regions balance — see the comment on the header below.
 */
const links = [
  { label: "Docs", to: "/docs/install" },
  { label: "Contributing", to: "/docs/contributing" },
  { label: "Demo", to: "/demo" },
];

const colorMode = useColorMode();
const isDark = computed({
  get: () => colorMode.value === "dark",
  set: (value) => {
    colorMode.preference = value ? "dark" : "light";
  },
});
</script>

<template>
  <!--
    `UHeader`'s theme lays the bar out as three regions: `left` (lg:flex-1),
    `center` (the default slot) and `right` (flex-1). The centre is only truly
    centred when left and right carry comparable width — flex items will not
    shrink below their content, so a wide brand block on the left against an
    empty right region (previously it held nothing but the `lg:hidden` mobile
    toggle) pushes the nav off-centre. Giving the right side real controls is
    what centres the nav; it is not a cosmetic addition.
  -->
  <UHeader :ui="{ left: 'lg:flex-1 min-w-0', right: 'lg:flex-1 min-w-0' }">
    <template #title>
      <span class="flex items-center gap-2.5">
        <img
          :src="`${baseURL}favicon-64.png`"
          alt=""
          width="28"
          height="28"
          class="size-7 shrink-0 rounded-[7px]"
        />
        <span class="truncate text-[15px] font-semibold tracking-tight">Luna Ultra Desktop</span>
      </span>
    </template>

    <UNavigationMenu :items="links" variant="link" />

    <template #right>
      <UContentSearchButton
        :collapsed="false"
        variant="outline"
        class="hidden w-44 justify-between sm:flex"
      />
      <UContentSearchButton :collapsed="true" variant="ghost" class="sm:hidden" />

      <UButton
        :icon="isDark ? 'i-lucide-moon' : 'i-lucide-sun'"
        color="neutral"
        variant="ghost"
        size="sm"
        :aria-label="isDark ? 'Switch to light theme' : 'Switch to dark theme'"
        @click="isDark = !isDark"
      />
      <UButton
        icon="i-simple-icons-github"
        color="neutral"
        variant="ghost"
        size="sm"
        to="https://github.com/Ripwords/insta360-luna-ultra-desktop"
        target="_blank"
        aria-label="View the source on GitHub"
      />
    </template>

    <template #body>
      <UContentSearchButton :collapsed="false" variant="outline" class="mb-4 w-full" />
      <UNavigationMenu :items="links" orientation="vertical" class="-mx-2.5" />
    </template>
  </UHeader>

  <!--
    Renders nothing until opened. `UContentSearchButton` above and this share
    `open` through Nuxt UI's `useContentSearch()` shared composable, so they do
    not need to be siblings or pass state. Cmd/Ctrl+K is bound by the component.
  -->
  <UContentSearch
    :files="searchFiles ?? []"
    :navigation="(navigation as ContentNavigationItem[] | undefined) ?? []"
    :search-status="searchStatus === 'pending' ? 'loading' : undefined"
    :fuse="{ resultLimit: 40 }"
  />

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
      <div class="flex items-center gap-2.5">
        <img
          :src="`${baseURL}favicon-32.png`"
          alt=""
          width="20"
          height="20"
          class="size-5 shrink-0 rounded-[5px] opacity-80"
        />
        <span class="text-sm text-muted">
          Unofficial companion app. Insta360 and Luna Ultra are trademarks of their respective
          owners.
        </span>
      </div>
    </template>

    <template #right>
      <UButton
        icon="i-simple-icons-github"
        color="neutral"
        variant="ghost"
        size="sm"
        to="https://github.com/Ripwords/insta360-luna-ultra-desktop"
        target="_blank"
        aria-label="View the source on GitHub"
      />
    </template>
  </UFooter>
</template>
