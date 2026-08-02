<script setup lang="ts">
import type { MediaItem } from "~/types/media";
import { watermarkNote, watermarkScope } from "~/utils/watermark";

const props = defineProps<{ items: MediaItem[] }>();

const emit = defineEmits<{ close: [confirmed: boolean] }>();

const scope = computed(() => watermarkScope(props.items));
const note = computed(() => watermarkNote(scope.value));
// Only a renderable photo can stand in for the watermark preview.
const previewSrc = computed(() => scope.value.watermarkable[0]?.srcUrl);

const summary = computed(() => {
  const photos = scope.value.watermarkable.length + scope.value.raw.length;
  const videos = scope.value.videos.length;
  const parts: string[] = [];
  if (photos > 0) parts.push(`${photos} ${photos === 1 ? "photo" : "photos"}`);
  if (videos > 0) parts.push(`${videos} ${videos === 1 ? "video" : "videos"}`);
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
      <WatermarkSettingsForm
        v-if="scope.watermarkable.length > 0"
        :preview-src="previewSrc"
        :note
      />
      <p v-else class="text-sm text-muted">{{ note }}</p>
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
