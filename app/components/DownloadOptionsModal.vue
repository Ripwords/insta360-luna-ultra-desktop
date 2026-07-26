<script setup lang="ts">
import type { MediaItem } from "~/types/media";

const props = defineProps<{ items: MediaItem[] }>();

const emit = defineEmits<{ close: [confirmed: boolean] }>();

const photos = computed(() => props.items.filter((item) => item.type === "photo"));
const videos = computed(() => props.items.filter((item) => item.type === "video"));
const previewSrc = computed(() => photos.value[0]?.srcUrl);

const summary = computed(() => {
  const parts: string[] = [];
  if (photos.value.length > 0)
    parts.push(`${photos.value.length} ${photos.value.length === 1 ? "photo" : "photos"}`);
  if (videos.value.length > 0)
    parts.push(`${videos.value.length} ${videos.value.length === 1 ? "video" : "videos"}`);
  return parts.join(" and ");
});
</script>

<template>
  <UModal
    :close="{ onClick: () => emit('close', false) }"
    :title="`Download ${summary}`"
    description="Files save to the Luna Ultra folder in Downloads."
    :ui="{ footer: 'justify-end' }"
  >
    <template #body>
      <WatermarkSettingsForm v-if="photos.length > 0" :preview-src="previewSrc" />
      <p v-else class="text-sm text-muted">
        Videos transfer untouched. Watermarking currently applies to photos only.
      </p>
    </template>

    <template #footer>
      <UButton label="Cancel" color="neutral" variant="outline" @click="emit('close', false)" />
      <UButton
        :label="items.length === 1 ? 'Download' : `Download ${items.length} files`"
        icon="i-lucide-arrow-down-to-line"
        @click="emit('close', true)"
      />
    </template>
  </UModal>
</template>
