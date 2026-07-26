<script setup lang="ts">
import ConfirmModal from "~/components/ConfirmModal.vue";
import DownloadOptionsModal from "~/components/DownloadOptionsModal.vue";
import type { MediaItem } from "~/types/media";
import type { MediaFilter, StorageFilter, ThumbSize } from "~/composables/useGallery";
import { isEquirectangular } from "~/utils/media";
import { setCameraQueuePaused } from "~/utils/cameraQueue";

useHead({ title: "Gallery" });

const { isConnected, loadingLibrary, refreshLibrary } = useCamera();
const {
  filter,
  storage,
  hasSdCard,
  thumbSize,
  selected,
  groups,
  orderedIds,
  selectedItems,
  deleting,
  select,
  selectGroup,
  clearSelection,
  deleteSelected,
} = useGallery();
const { enqueue } = useDownloads();
const { settings } = useWatermarkSettings();
const overlay = useOverlay();
const confirmModal = overlay.create(ConfirmModal);
const downloadModal = overlay.create(DownloadOptionsModal);

const filterTabs: Array<{ label: string; value: MediaFilter }> = [
  { label: "All", value: "all" },
  { label: "Photos", value: "photo" },
  { label: "Videos", value: "video" },
];

const storageItems: Array<{ label: string; value: StorageFilter; icon: string }> = [
  { label: "All storage", value: "all", icon: "i-lucide-database" },
  { label: "Internal", value: "internal", icon: "i-lucide-hard-drive" },
  { label: "SD card", value: "sdcard", icon: "i-lucide-memory-stick" },
];

const sizes: Array<{ value: ThumbSize; icon: string; label: string }> = [
  { value: "sm", icon: "i-lucide-grid-3x3", label: "Small thumbnails" },
  { value: "md", icon: "i-lucide-grid-2x2", label: "Medium thumbnails" },
  { value: "lg", icon: "i-lucide-square", label: "Large thumbnails" },
];

const tileMin = computed(() => ({ sm: 116, md: 164, lg: 236 })[thumbSize.value]);

const totalCount = computed(() => orderedIds.value.length);
const selectionActive = computed(() => selected.value.size > 0);

const allById = computed(() => {
  const map = new Map<string, MediaItem>();
  for (const group of groups.value) {
    for (const item of group.items) map.set(item.id, item);
  }
  return map;
});

// Fullscreen preview state
const previewOpen = ref(false);
const previewId = ref<string | null>(null);

// While an item is open full-screen, hold back background grid thumbnails so
// the camera's single connection loads the opened photo/video first.
watch(previewOpen, (open) => setCameraQueuePaused(open));
onBeforeUnmount(() => setCameraQueuePaused(false));
const previewItem = computed(() =>
  previewId.value ? (allById.value.get(previewId.value) ?? null) : null,
);
const previewIndex = computed(() =>
  previewId.value ? orderedIds.value.indexOf(previewId.value) : -1,
);

/**
 * Record a photo's real pixel size once it decodes, and promote it to an
 * interactive 360 when it turns out to be equirectangular (2:1). The Luna's
 * 360 stills are named IMG_*.jpg with no pano metadata, so this is the only
 * reliable point of detection. Mutating the shared library item reactively
 * updates its grid badge and swaps the open preview to the pano viewer.
 */
function annotateDimensions(item: MediaItem | null, dimensions: { width: number; height: number }) {
  if (!item || item.type !== "photo") return;
  if (item.width === dimensions.width && item.height === dimensions.height) return;
  item.width = dimensions.width;
  item.height = dimensions.height;
  if (!item.panoramic && isEquirectangular(dimensions.width, dimensions.height)) {
    item.panoramic = true;
  }
}

function openPreview(item: MediaItem) {
  previewId.value = item.id;
  previewOpen.value = true;
}

function stepPreview(delta: number) {
  const nextIndex = previewIndex.value + delta;
  const id = orderedIds.value[nextIndex];
  if (id) previewId.value = id;
}

async function confirmDelete(items: MediaItem[]) {
  const instance = confirmModal.open({
    title: items.length === 1 ? `Delete ${items[0]!.name}?` : `Delete ${items.length} files?`,
    description: "This permanently erases the files from the camera storage. It cannot be undone.",
    confirmLabel: "Delete",
  });
  return await instance.result;
}

async function onDeleteSelection() {
  if (await confirmDelete(selectedItems.value)) await deleteSelected();
}

async function onDeleteFromPreview() {
  const item = previewItem.value;
  if (!item || !(await confirmDelete([item]))) return;
  previewOpen.value = false;
  selected.value = new Set([item.id]);
  await deleteSelected();
}

async function downloadWithOptions(items: MediaItem[]): Promise<boolean> {
  const instance = downloadModal.open({ items });
  if (!(await instance.result)) return false;
  enqueue(items, { watermark: settings.value.enabled });
  return true;
}

async function onDownloadSelection() {
  if (await downloadWithOptions(selectedItems.value)) clearSelection();
}

function onDownloadFromPreview() {
  if (previewItem.value) void downloadWithOptions([previewItem.value]);
}

defineShortcuts({
  meta_a: {
    handler: () => {
      selected.value = new Set(orderedIds.value);
    },
    usingInput: false,
  },
  escape: () => {
    if (!previewOpen.value) clearSelection();
  },
});
</script>

<template>
  <UDashboardPanel id="gallery">
    <template #header>
      <UDashboardNavbar title="Gallery">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <span v-if="isConnected" class="font-mono text-xs text-muted tabular-nums">
            {{ totalCount }} {{ totalCount === 1 ? "file" : "files" }}
          </span>
          <UButton
            v-if="isConnected"
            icon="i-lucide-refresh-cw"
            size="xs"
            color="neutral"
            variant="ghost"
            :loading="loadingLibrary"
            aria-label="Refresh library"
            @click="refreshLibrary"
          />
        </template>
      </UDashboardNavbar>

      <UDashboardToolbar v-if="isConnected">
        <template #left>
          <UTabs v-model="filter" :items="filterTabs" :content="false" size="xs" color="neutral" />
          <USelect
            v-if="hasSdCard"
            v-model="storage"
            :items="storageItems"
            value-key="value"
            size="xs"
            :icon="storageItems.find((s) => s.value === storage)?.icon"
            class="w-36"
          />
        </template>
        <template #right>
          <UFieldGroup>
            <UButton
              v-for="size in sizes"
              :key="size.value"
              :icon="size.icon"
              size="xs"
              :aria-label="size.label"
              :color="thumbSize === size.value ? 'primary' : 'neutral'"
              :variant="thumbSize === size.value ? 'solid' : 'outline'"
              @click="thumbSize = size.value"
            />
          </UFieldGroup>
        </template>
      </UDashboardToolbar>
    </template>

    <template #body>
      <div
        v-if="!isConnected"
        class="flex h-full flex-col items-center justify-center gap-4 text-center"
      >
        <span class="flex size-14 items-center justify-center rounded-2xl bg-muted">
          <UIcon name="i-lucide-camera-off" class="size-7 text-dimmed" />
        </span>
        <div class="space-y-1">
          <p class="font-medium text-highlighted">No camera connected</p>
          <p class="max-w-xs text-sm text-muted">
            Pair your Luna Ultra over Wi-Fi to browse its media library.
          </p>
        </div>
        <UButton label="Go to Connect" icon="i-lucide-cable" to="/" />
      </div>

      <div
        v-else-if="loadingLibrary && groups.length === 0"
        class="space-y-8"
        role="status"
        aria-busy="true"
        aria-label="Reading the camera library"
      >
        <section v-for="section in 2" :key="section" aria-hidden="true">
          <div class="mb-2.5 h-5 w-32 animate-pulse rounded bg-elevated" />
          <div
            class="grid gap-2"
            :style="{ gridTemplateColumns: `repeat(auto-fill, minmax(${tileMin}px, 1fr))` }"
          >
            <div
              v-for="tile in 12"
              :key="tile"
              class="aspect-square animate-pulse rounded-lg bg-elevated"
            />
          </div>
        </section>
      </div>

      <div
        v-else-if="groups.length === 0"
        class="flex h-full flex-col items-center justify-center gap-4 text-center"
      >
        <span class="flex size-14 items-center justify-center rounded-2xl bg-muted">
          <UIcon name="i-lucide-image-off" class="size-7 text-dimmed" />
        </span>
        <div class="space-y-1">
          <p class="font-medium text-highlighted">Nothing here</p>
          <p class="max-w-xs text-sm text-muted">
            No {{ filter === "all" ? "media" : `${filter}s` }} on the camera right now.
          </p>
        </div>
        <UButton
          v-if="filter !== 'all'"
          label="Show everything"
          color="neutral"
          variant="outline"
          @click="filter = 'all'"
        />
      </div>

      <div v-else class="space-y-8 pb-24">
        <section v-for="group in groups" :key="group.key" :aria-label="group.label">
          <div class="mb-2.5 flex items-baseline gap-3">
            <h2 class="text-sm font-semibold text-highlighted">{{ group.label }}</h2>
            <span class="font-mono text-xs text-muted tabular-nums">{{ group.items.length }}</span>
            <UButton
              :label="group.items.every((i) => selected.has(i.id)) ? 'Deselect day' : 'Select day'"
              size="xs"
              color="neutral"
              variant="ghost"
              @click="selectGroup(group.items.map((i) => i.id))"
            />
          </div>

          <div
            class="grid gap-2"
            :style="{ gridTemplateColumns: `repeat(auto-fill, minmax(${tileMin}px, 1fr))` }"
          >
            <MediaTile
              v-for="item in group.items"
              :key="item.id"
              :item
              :selected="selected.has(item.id)"
              :selection-active="selectionActive"
              @open="openPreview(item)"
              @select="select(item, $event)"
              @loaded="annotateDimensions(item, $event)"
            />
          </div>
        </section>
      </div>

      <SelectionBar
        :count="selected.size"
        :deleting
        @download="onDownloadSelection"
        @delete="onDeleteSelection"
        @clear="clearSelection"
      />

      <MediaPreview
        v-model:open="previewOpen"
        :item="previewItem"
        :has-prev="previewIndex > 0"
        :has-next="previewIndex >= 0 && previewIndex < orderedIds.length - 1"
        @prev="stepPreview(-1)"
        @next="stepPreview(1)"
        @download="onDownloadFromPreview"
        @delete="onDeleteFromPreview"
        @loaded="annotateDimensions(previewItem, $event)"
      />
    </template>
  </UDashboardPanel>
</template>
