import type { DownloadEntry, MediaItem } from "~/types/media";
import { canWatermark, watermarkNote, watermarkScope } from "~/utils/watermark";
import { renderWatermarked } from "~/utils/watermarkClient";
import { saveBlob } from "~/utils/saveFile";
import { getCameraTransport } from "~/utils/transport";

export function useDownloads() {
  const queue = useState<DownloadEntry[]>("download-queue", () => []);
  const { library } = useCamera();
  const { settings } = useWatermarkSettings();
  const toast = useToast();
  const running = useState<boolean>("download-running", () => false);

  const active = computed(() =>
    queue.value.filter((entry) => entry.status === "queued" || entry.status === "downloading"),
  );
  const completed = computed(() => queue.value.filter((entry) => entry.status === "done"));

  /**
   * Drain the queue one transfer at a time. A loop rather than tail recursion:
   * recursing per file left a promise frame per completed download alive for
   * the whole run, so a few hundred queued files nested a few hundred deep.
   */
  async function processNext(): Promise<void> {
    for (;;) {
      const entry = queue.value.find((candidate) => candidate.status === "queued");
      if (!entry) {
        running.value = false;
        return;
      }
      patch(entry.id, { status: "downloading", progress: 4 });
      try {
        const response = await getCameraTransport().fetch(entry.item.srcUrl);
        if (!response.ok) throw new Error(`Camera transfer failed (${response.status})`);
        patch(entry.id, { progress: 45 });
        let blob = await response.blob();
        // Measured before the watermark pass: this is the file's size on the
        // camera, not the size of what we are about to write to disk.
        recordSize(entry.item, blob.size);
        patch(entry.id, { progress: 70 });
        // Renderable photos only: RAW is `type: "photo"` too, but the canvas
        // pipeline cannot decode it, so it saves unmodified (issue #2).
        if (entry.watermarked && canWatermark(entry.item)) {
          blob = await renderWatermarked(blob, settings.value);
        }
        patch(entry.id, { progress: 90 });
        const savedTo = await saveBlob(blob, entry.item.name);
        patch(entry.id, { status: "done", progress: 100, savedTo });
      } catch (error) {
        patch(entry.id, {
          status: "error",
          error: error instanceof Error ? error.message : "Transfer failed",
        });
      }
    }
  }

  /**
   * Record the transferred byte count. On firmware that disabled the HTTP
   * autoindex the library comes from GET_FILE_LIST, which reports no size, so
   * a downloaded file is the only place a real byte count ever appears — the
   * Downloads row would otherwise read `0 B`. `blob.size` is exact and needs
   * no `content-length` support, and it also beats the index listing's rounded
   * "18M", so it wins over whatever the item carried.
   *
   * Written back to the shared library item as well as the queue entry: the
   * gallery may hand over a copy, and the size belongs to the file rather than
   * to this one transfer, so re-downloading isn't the only way to learn it.
   */
  function recordSize(item: MediaItem, size: number) {
    if (size <= 0) return;
    item.size = size;
    const libraryItem = library.value.find((candidate) => candidate.id === item.id);
    if (libraryItem && libraryItem !== item) libraryItem.size = size;
  }

  /**
   * Update one entry in place. Rebuilding the array instead re-ran every
   * queue-wide computed on each progress tick — five times per file, against a
   * list that grows with the batch. Vue tracks the mutated fields directly, so
   * a progress change now only invalidates what actually reads progress.
   */
  function patch(id: string, changes: Partial<DownloadEntry>) {
    const entry = queue.value.find((candidate) => candidate.id === id);
    if (entry) Object.assign(entry, changes);
  }

  function enqueue(items: MediaItem[], options: { watermark: boolean }) {
    const stamp = Date.now();
    const entries: DownloadEntry[] = items.map((item, index) => ({
      id: `${stamp}-${item.id}`,
      item,
      status: "queued",
      progress: 0,
      watermarked: options.watermark,
      startedAt: stamp + index,
    }));
    queue.value = [...entries, ...queue.value];
    const scope = watermarkScope(items);
    toast.add({
      title: `Downloading ${items.length} ${items.length === 1 ? "file" : "files"}`,
      description: options.watermark ? watermarkNote(scope) : undefined,
      icon: "i-lucide-arrow-down-to-line",
    });
    if (!running.value) {
      running.value = true;
      void processNext();
    }
  }

  function retry(id: string) {
    patch(id, { status: "queued", progress: 0, error: undefined });
    if (!running.value) {
      running.value = true;
      void processNext();
    }
  }

  function clearFinished() {
    queue.value = queue.value.filter(
      (entry) => entry.status !== "done" && entry.status !== "error",
    );
  }

  return { queue, active, completed, enqueue, retry, clearFinished };
}
