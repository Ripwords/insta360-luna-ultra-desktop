import type { DownloadEntry, MediaItem } from "~/types/media";
import { renderWatermarked } from "~/utils/watermarkClient";
import { saveBlob } from "~/utils/saveFile";
import { useCameraTransport } from "~/utils/transport";

export function useDownloads() {
  const queue = useState<DownloadEntry[]>("download-queue", () => []);
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
        const response = await useCameraTransport().fetch(entry.item.srcUrl);
        if (!response.ok) throw new Error(`Camera transfer failed (${response.status})`);
        patch(entry.id, { progress: 45 });
        let blob = await response.blob();
        patch(entry.id, { progress: 70 });
        if (entry.watermarked && entry.item.type === "photo") {
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
    toast.add({
      title: `Downloading ${items.length} ${items.length === 1 ? "file" : "files"}`,
      description: options.watermark ? "Watermark will be applied to photos" : undefined,
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
