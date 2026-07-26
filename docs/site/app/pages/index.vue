<script setup lang="ts">
useSeoMeta({
  title: "Luna Ultra Desktop",
  description:
    "A desktop companion for the Insta360 Luna Ultra. Live viewfinder, camera control, gallery, and watermarked downloads on macOS, Windows and Linux.",
  // A plain static asset, not `defineOgImageComponent()` — see the long
  // comment on `ogImage` in `nuxt.config.ts` for why the satori/component
  // route (`nuxt-og-image`'s intended, dynamic path) doesn't work in this
  // install and had to be abandoned in favour of this.
  //
  // Written out fully-qualified rather than "/og.png": `nuxt-og-image`
  // normally absolutizes any relative `og:image` itself (its
  // `og-image-canonical-urls` server plugin), but that plugin is also
  // affected by the same `@unhead/vue` v2/v3 duplicate-install conflict
  // documented in `components/JsonLd.vue` and left "/og.png" unresolved in
  // the generated HTML — confirmed by inspecting the output before this
  // change. Hardcoding the full URL sidesteps that broken step entirely.
  ogImage: "https://ripwords.github.io/insta360-luna-ultra-desktop/og.png",
});

// See `components/JsonLd.vue` for why this is hand-rolled rather than
// `useSchemaOrg()`/`defineSoftwareApp()`.
const softwareApp = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Luna Ultra Desktop",
  applicationCategory: "MultimediaApplication",
  operatingSystem: "macOS, Windows, Linux",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  url: "https://ripwords.github.io/insta360-luna-ultra-desktop",
};
</script>

<template>
  <UPageHero
    title="Drive your Luna Ultra from the desktop"
    description="Connect over Wi-Fi for a live viewfinder, full camera control, a date-grouped gallery, and batch downloads with the official watermark. macOS, Windows and Linux."
    :links="[
      {
        label: 'Download',
        to: 'https://github.com/Ripwords/insta360-luna-ultra-desktop/releases/latest',
        icon: 'i-lucide-download',
      },
      { label: 'Read the docs', to: '/docs/install', variant: 'subtle' },
    ]"
  />
  <JsonLd :data="softwareApp" />
</template>
