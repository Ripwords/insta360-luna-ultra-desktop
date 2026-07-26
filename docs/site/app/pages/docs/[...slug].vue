<script setup lang="ts">
const route = useRoute();

// GitHub Pages 301-redirects extensionless directory paths to a trailing
// slash, but the content collection stores paths without one — so look up
// the normalised path or the page body silently renders empty on hydration.
const contentPath = computed(() => route.path.replace(/\/+$/, "") || "/");

const { data: page } = await useAsyncData(`docs-${contentPath.value}`, () =>
  queryCollection("docs").path(contentPath.value).first(),
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
