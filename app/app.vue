<script setup lang="ts">
useHead({
  title: "Luna Ultra",
  titleTemplate: (chunk) =>
    chunk && chunk !== "Luna Ultra" ? `${chunk} · Luna Ultra` : "Luna Ultra",
});
</script>

<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
