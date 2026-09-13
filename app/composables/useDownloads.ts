import type { DownloadEntry, MediaItem } from "~/types/media";
import { canWatermark, watermarkNote, watermarkScope } from "~/utils/watermark";
import { cacheRawPreviewFromBlob, isRawPhoto } from "~/utils/rawPreviewCache";
import { renderWatermarked } from "~/utils/watermarkClient";
import { saveBlob } from "~/utils/saveFile";
import { streamCameraFileToDisk } from "~/utils/streamDownload";
import { getCameraTransport } from "~/utils/transport";
import { beginHealthTransfer, endHealthTransfer } from "~/utils/cameraHealth";
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
      const transport = getCameraTransport();
      // Told to the keepalive loop so it tolerates a slower control-channel
      // reply for as long as this transfer runs, rather than mistaking a
      // camera that's busy serving a large file for one that's gone (issue:
      // 8K video downloads getting silently killed mid-transfer). Bracketed
      // with try/finally so a failed or aborted download still clears it.
      await transport.beginTransfer?.();
      beginHealthTransfer();
      try {
        const response = await transport.fetch(entry.item.srcUrl);
        if (!response.ok) throw new Error(`Camera transfer failed (${response.status})`);
        patch(entry.id, { progress: 45 });

        if (entry.item.type === "video") {
          // Stream straight to disk rather than buffering the whole file in
          // the webview's memory. A full-res 8K video can run several GB;
          // `response.blob()` accumulates that into one in-memory buffer
          // before returning it, which has been observed to crash the
          // webview process outright (blank window, nothing on disk, no
          // error — because nothing ever gets the chance to throw one).
          // Videos are never watermarked (see docs/FEATURES.md) and have no
          // RAW-preview step, so nothing downstream needs the bytes in
          // memory here. See app/utils/streamDownload.ts for the mechanism.
          const { savedTo, size } = await streamCameraFileToDisk(
            response,
            entry.item.name,
            (written, total) => {
              // `entry.item.size` is only a real prior measurement, never a
              // stand-in for "no total": on GET_FILE_LIST firmware it starts
              // at 0 for every file until a download has measured it once
              // (see lunaIndex.ts). Falling back to `written` itself here
              // (as this used to) makes fraction = written / written = 1 on
              // the very first chunk — a bar that hits ~95% instantly and
              // never moves again, regardless of real progress.
              const knownTotal = total ?? (entry.item.size > 0 ? entry.item.size : null);
              if (knownTotal && knownTotal > 0) {
                const fraction = Math.min(1, written / knownTotal);
                patch(entry.id, {
                  progress: Math.min(95, 45 + Math.round(fraction * 50)),
                  bytesWritten: written,
                });
              } else {
                // No content-length and no prior measurement: there is no
                // number to show a meaningful percentage against, so render
                // an indeterminate bar (UProgress treats null as such) and
                // let the UI fall back to showing raw bytes transferred.
                patch(entry.id, { progress: null, bytesWritten: written });
              }
            },
          );
          recordSize(entry.item, size);
          patch(entry.id, { status: "done", progress: 100, savedTo });
        } else {
          const source = await response.blob();
          let blob = source;
          // Measured before the watermark pass: this is the file's size on
          // the camera, not the size of what we are about to write to disk.
          recordSize(entry.item, source.size);
          patch(entry.id, { progress: 70 });
          // Renderable photos only: RAW is `type: "photo"` too, but the canvas
          // pipeline cannot decode it, so it saves unmodified (issue #2).
          if (entry.watermarked && canWatermark(entry.item)) {
            blob = await renderWatermarked(blob, settings.value);
          }
          patch(entry.id, { progress: 90 });
          const savedTo = await saveBlob(blob, entry.item.name);
          patch(entry.id, { status: "done", progress: 100, savedTo });
          await seedRawPreview(entry.item, source);
        }
      } catch (error) {
        patch(entry.id, {
          status: "error",
          error: error instanceof Error ? error.message : "Transfer failed",
        });
      } finally {
        endHealthTransfer();
        await transport.endTransfer?.();
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
   * Derive a RAW's preview from the bytes this transfer already pulled.
   *
   * A `.dng` is `renderable: false`, so every surface showing one — the
   * Downloads row, the gallery tile — otherwise has nothing to display but a
   * placeholder, and deriving it on demand would mean re-fetching tens of MB
   * over the camera's Wi-Fi for a thumbnail. Seeding the shared media cache
   * here makes that view free.
   *
   * Runs after the entry is marked done, and swallows failures: the file is
   * already on disk, and a thumbnail is not worth failing a good download over.
   */
  async function seedRawPreview(item: MediaItem, source: Blob) {
    if (!isRawPhoto(item)) return;
    try {
      await cacheRawPreviewFromBlob(item, source);
    } catch {
      // Cosmetic only — the download itself succeeded.
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
    patch(id, { status: "queued", progress: 0, bytesWritten: undefined, error: undefined });
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
