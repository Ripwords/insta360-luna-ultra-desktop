import type { DownloadEntry, MediaItem } from "~/types/media";
import { drawWatermark } from "~/utils/watermark";
import { saveBlob } from "~/utils/saveFile";
import { cameraFetch } from "~/utils/lunaClient";

async function renderWithWatermark(
  item: MediaItem,
  blob: Blob,
  settings: ReturnType<typeof useWatermarkSettings>["settings"],
): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return blob;
  ctx.drawImage(bitmap, 0, 0);
  await drawWatermark(ctx, bitmap.width, bitmap.height, settings.value);
  bitmap.close();
  return await new Promise<Blob>((resolve) => {
    canvas.toBlob((out) => resolve(out ?? blob), "image/jpeg", 0.92);
  });
}

export function useDownloads() {
  const queue = useState<DownloadEntry[]>("download-queue", () => []);
  const { settings } = useWatermarkSettings();
  const toast = useToast();
  const running = useState<boolean>("download-running", () => false);

  const active = computed(() =>
    queue.value.filter((entry) => entry.status === "queued" || entry.status === "downloading"),
  );
  const completed = computed(() => queue.value.filter((entry) => entry.status === "done"));

  async function processNext(): Promise<void> {
    const entry = queue.value.find((candidate) => candidate.status === "queued");
    if (!entry) {
      running.value = false;
      return;
    }
    patch(entry.id, { status: "downloading", progress: 4 });
    try {
      const response = await cameraFetch(entry.item.srcUrl);
      if (!response.ok) throw new Error(`Camera transfer failed (${response.status})`);
      patch(entry.id, { progress: 45 });
      let blob = await response.blob();
      patch(entry.id, { progress: 70 });
      const watermarking = entry.watermarked && entry.item.type === "photo";
      if (watermarking) {
        blob = await renderWithWatermark(entry.item, blob, settings);
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
    await processNext();
  }

  function patch(id: string, changes: Partial<DownloadEntry>) {
    queue.value = queue.value.map((entry) => (entry.id === id ? { ...entry, ...changes } : entry));
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
