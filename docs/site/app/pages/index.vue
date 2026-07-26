<script setup lang="ts">
useSeoMeta({
  title: "Luna Ultra Desktop",
  description:
    "A desktop companion for the Insta360 Luna Ultra. Live viewfinder, camera control, gallery, and watermarked downloads on macOS, Windows and Linux.",
});
</script>

<template>
  <UPageHero
    title="Drive your Luna Ultra from the desktop"
    description="Connect over Wi-Fi for a live viewfinder, full camera control, a date-grouped gallery, and batch downloads with the official watermark. macOS, Windows and Linux."
    :links="[
      {
        label: 'Download',
        to: 'https://github.com/Ripwords/luna-ultra-desktop/releases/latest',
        icon: 'i-lucide-download',
      },
      { label: 'Read the docs', to: '/docs/install', variant: 'subtle' },
    ]"
  />
</template>
