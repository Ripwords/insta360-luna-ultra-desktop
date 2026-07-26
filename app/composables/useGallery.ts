import type { MediaItem } from "~/types/media";
import { dayLabel, groupByDay } from "~/utils/media";
import { rangeSelect, toggleGroup, toggleId } from "~/utils/selection";
import { lunaClient } from "~/utils/lunaClient";

export type MediaFilter = "all" | "photo" | "video";
export type StorageFilter = "all" | "internal" | "sdcard";
export type ThumbSize = "sm" | "md" | "lg";

export function useGallery() {
  const { library, removeFromLibrary } = useCamera();
  const filter = useState<MediaFilter>("gallery-filter", () => "all");
  const storage = useState<StorageFilter>("gallery-storage", () => "all");
  const thumbSize = useState<ThumbSize>("gallery-thumb-size", () => "md");
  const selected = useState<Set<string>>("gallery-selected", () => new Set());
  const anchor = useState<string | null>("gallery-anchor", () => null);
  const toast = useToast();

  /** True once the camera reports files on a removable SD card. */
  const hasSdCard = computed(() => library.value.some((item) => item.storage === "sdcard"));

  const filtered = computed(() =>
    library.value.filter((item) => {
      if (filter.value !== "all" && item.type !== filter.value) return false;
      if (storage.value !== "all" && item.storage !== storage.value) return false;
      return true;
    }),
  );

  const groups = computed(() =>
    groupByDay(filtered.value).map((group) => ({ ...group, label: dayLabel(group.key) })),
  );

  const orderedIds = computed(() =>
    groups.value.flatMap((group) => group.items.map((item) => item.id)),
  );

  const selectedItems = computed(() => {
    const set = selected.value;
    return library.value.filter((item) => set.has(item.id));
  });

  function select(item: MediaItem, event?: MouseEvent) {
    if (event?.shiftKey) {
      selected.value = rangeSelect(orderedIds.value, selected.value, anchor.value, item.id);
    } else {
      selected.value = toggleId(selected.value, item.id);
    }
    anchor.value = selected.value.has(item.id) ? item.id : null;
  }

  function selectGroup(ids: string[]) {
    selected.value = toggleGroup(selected.value, ids);
  }

  function clearSelection() {
    selected.value = new Set();
    anchor.value = null;
  }

  const deleting = ref(false);

  /**
   * Delete the selected files on the camera. This is a real, irreversible
   * TCP delete command; there is no undo. The local library is only updated
   * after the camera confirms.
   */
  async function deleteSelected(): Promise<void> {
    const removed = library.value.filter((item) => selected.value.has(item.id));
    if (removed.length === 0 || deleting.value) return;
    deleting.value = true;
    try {
      await lunaClient.deleteFiles(removed.map((item) => item.cameraPath));
      removeFromLibrary(removed.map((item) => item.cameraPath));
      clearSelection();
      toast.add({
        title: `Deleted ${removed.length} ${removed.length === 1 ? "file" : "files"} from the camera`,
        icon: "i-lucide-trash-2",
        color: "success",
      });
    } catch (e) {
      toast.add({
        title: "Delete failed",
        description: e instanceof Error ? e.message : "The camera rejected the delete request.",
        icon: "i-lucide-triangle-alert",
        color: "error",
      });
    } finally {
      deleting.value = false;
    }
  }

  return {
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
  };
}
