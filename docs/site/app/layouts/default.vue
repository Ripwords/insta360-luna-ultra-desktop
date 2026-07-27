<script setup lang="ts">
import type { ContentNavigationItem } from "@nuxt/content";

const { data: navigation } = await useAsyncData("docs-navigation", () =>
  queryCollectionNavigation("docs"),
);

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
      <UNavigationMenu :items="links" orientation="vertical" class="-mx-2.5" />
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
