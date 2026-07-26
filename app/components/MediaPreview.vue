<script setup lang="ts">
import type { MediaItem } from "~/types/media";
import { formatBytes, formatDuration } from "~/utils/media";

const props = defineProps<{
  item: MediaItem | null;
  hasPrev: boolean;
  hasNext: boolean;
}>();

const open = defineModel<boolean>("open", { required: true });

const emit = defineEmits<{
  prev: [];
  next: [];
  download: [];
  delete: [];
  loaded: [dimensions: { width: number; height: number }];
}>();

const videoEl = useTemplateRef<HTMLVideoElement>("videoEl");

/**
 * Space toggles video play/pause. Captured on window because the modal's focus
 * trap parks focus on a button, where a bubbling handler would either miss the
 * event or let space "click" that button instead. We consume both keydown
 * (toggle) and keyup (so the focused button is never activated), skipping only
 * genuine text inputs.
 */
function onSpaceKey(event: KeyboardEvent) {
  if (!open.value || (event.key !== " " && event.code !== "Space")) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
  const video = videoEl.value;
  if (!video) return;
  event.preventDefault();
  if (event.type !== "keydown") return;
  if (video.paused) void video.play();
  else video.pause();
}

onMounted(() => {
  window.addEventListener("keydown", onSpaceKey, true);
  window.addEventListener("keyup", onSpaceKey, true);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onSpaceKey, true);
  window.removeEventListener("keyup", onSpaceKey, true);
});

const takenLabel = computed(() => {
  if (!props.item) return "";
  return new Date(props.item.takenAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
});

const moreItems = computed(() => [
  [
    {
      label: "Delete from camera",
      icon: "i-lucide-trash-2",
      color: "error" as const,
      onSelect: () => emit("delete"),
    },
  ],
]);

// While the overflow menu is open it owns the keyboard: Escape should close
// the menu, not the whole preview, and the arrows should not navigate files
// underneath it.
const moreOpen = ref(false);

defineShortcuts({
  arrowleft: () => {
    if (open.value && !moreOpen.value) emit("prev");
  },
  arrowright: () => {
    if (open.value && !moreOpen.value) emit("next");
  },
  escape: () => {
    if (open.value && !moreOpen.value) open.value = false;
  },
});
</script>

<template>
  <UModal
    v-model:open="open"
    fullscreen
    :ui="{ content: 'bg-default', body: 'p-0 sm:p-0' }"
    :title="item?.name ?? 'Preview'"
    :description="takenLabel"
  >
    <template #content>
      <div v-if="item" class="flex h-full flex-col">
        <div class="flex items-center justify-between gap-4 border-b border-default px-4 py-2.5">
          <div class="min-w-0">
            <p class="truncate font-mono text-sm text-highlighted">{{ item.name }}</p>
            <p class="text-xs text-muted">{{ takenLabel }}</p>
          </div>
          <div class="flex items-center gap-1.5">
            <UButton
              icon="i-lucide-arrow-down-to-line"
              label="Download"
              size="sm"
              color="neutral"
              variant="outline"
              @click="emit('download')"
            />
            <UDropdownMenu v-model:open="moreOpen" :items="moreItems">
              <UButton
                icon="i-lucide-ellipsis"
                size="sm"
                color="neutral"
                variant="ghost"
                aria-label="More actions"
              />
            </UDropdownMenu>
            <span class="mx-1 h-5 w-px bg-default" aria-hidden="true" />
            <UButton
              icon="i-lucide-x"
              size="sm"
              color="neutral"
              variant="ghost"
              aria-label="Close preview"
              @click="open = false"
            />
          </div>
        </div>

        <div
          class="relative flex min-h-0 flex-1 items-center justify-center bg-black/95 px-16 dark:bg-black"
        >
          <!-- Play the low-res LRV proxy when available; the full-res file can
               be hundreds of MB and is meant for download, not preview. -->
          <video
            v-if="item.type === 'video'"
            ref="videoEl"
            :key="item.id"
            :src="item.lrvUrl ?? item.srcUrl"
            controls
            playsinline
            class="max-h-full max-w-full"
          />
          <PanoViewer
            v-else-if="item.panoramic && item.renderable"
            :key="`pano-${item.id}`"
            :src="item.srcUrl"
            class="absolute inset-0"
          />
          <CameraImage
            v-else-if="item.renderable"
            :key="item.id"
            :src="item.srcUrl"
            :alt="item.name"
            eager
            img-class="max-h-full max-w-full object-contain"
            @loaded="emit('loaded', $event)"
          />
          <RawImage
            v-else
            :key="`raw-${item.id}`"
            :src="item.srcUrl"
            :ext="item.ext"
            eager
            prefer="largest"
            img-class="max-h-full max-w-full object-contain"
          >
            <template #fallback="{ reason }">
              <div class="flex flex-col items-center gap-3 text-center text-muted">
                <UIcon name="i-lucide-aperture" class="size-12 text-dimmed" />
                <div class="space-y-1">
                  <p class="font-mono text-sm uppercase text-highlighted">{{ item.ext }} file</p>
                  <p class="max-w-xs text-sm">
                    <template v-if="reason === 'network'"
                      >The download from the camera failed or was interrupted. Try again or download
                      the file.</template
                    >
                    <template v-else-if="reason === 'decode-failed'"
                      >Downloaded, but rendering this RAW file's preview failed. Download it to open
                      in your photo editor.</template
                    >
                    <template v-else
                      >No embedded preview in this RAW file. Download it to open in your photo
                      editor.</template
                    >
                  </p>
                </div>
                <UButton
                  label="Download"
                  icon="i-lucide-arrow-down-to-line"
                  color="neutral"
                  variant="outline"
                  @click="emit('download')"
                />
              </div>
            </template>
          </RawImage>

          <UButton
            v-if="hasPrev"
            icon="i-lucide-chevron-left"
            size="lg"
            color="neutral"
            variant="solid"
            class="absolute left-3 top-1/2 -translate-y-1/2"
            aria-label="Previous file"
            @click="emit('prev')"
          />
          <UButton
            v-if="hasNext"
            icon="i-lucide-chevron-right"
            size="lg"
            color="neutral"
            variant="solid"
            class="absolute right-3 top-1/2 -translate-y-1/2"
            aria-label="Next file"
            @click="emit('next')"
          />
        </div>

        <div
          class="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-default px-4 py-2.5 font-mono text-xs text-muted"
        >
          <span v-if="item.width && item.height">{{ item.width }} × {{ item.height }}</span>
          <span v-if="item.size > 0">{{ formatBytes(item.size) }}</span>
          <span class="uppercase">{{ item.type }}</span>
          <span v-if="item.duration != null">{{ formatDuration(item.duration) }}</span>
        </div>
      </div>
    </template>
  </UModal>
</template>
