<script setup lang="ts">
const route = useRoute();

const { data: page } = await useAsyncData(`docs-${route.path}`, () =>
  queryCollection("docs").path(route.path).first(),
);

if (!page.value) {
  throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true });
}

useSeoMeta({
  title: page.value.title,
  description: page.value.description,
});
</script>

<template>
  <UPage v-if="page">
    <UPageHeader :title="page.title" :description="page.description" />
    <UPageBody>
      <ContentRenderer :value="page" />
    </UPageBody>

    <template #right>
      <UContentToc :links="page.body?.toc?.links ?? []" />
    </template>
  </UPage>
</template>
