import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadEntry } from "~/types/media";
import { resetCameraTransport, setCameraTransport } from "~/utils/transport";
import { makeFakeTransport } from "../helpers/fakeTransport";
import { makeMediaItem } from "../helpers/media";
import { mountComposable } from "./harness";

const CAMERA_BYTES = 4096;

// The watermarked blob is deliberately a different size from the camera's, so
// tests can tell which of the two a recorded byte count came from.
const { WATERMARKED_BYTES, renderWatermarked } = vi.hoisted(() => {
  const WATERMARKED_BYTES = 9000;
  return {
    WATERMARKED_BYTES,
    renderWatermarked: vi.fn(
      async (_blob: Blob, _settings?: unknown) => new Blob([new Uint8Array(WATERMARKED_BYTES)]),
    ),
  };
});
const saveBlob = vi.hoisted(() =>
  vi.fn(async (_blob: Blob, fileName: string) => `Downloads/Luna Ultra/${fileName}`),
);

vi.mock("~/utils/watermarkClient", () => ({ renderWatermarked }));
vi.mock("~/utils/saveFile", () => ({ saveBlob, isTauri: () => false }));

mockNuxtImport("useToast", () => () => ({
  add: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  clear: vi.fn(),
  toasts: [],
}));

function respondWith(bytes: number) {
  // Uint8Array rather than a Blob body: this environment's Response
  // stringifies a Blob instead of streaming it.
  return makeFakeTransport({
    fetch: vi.fn(async () => new Response(new Uint8Array(bytes), { status: 200 })),
  });
}

/** Resolve once every queued transfer has reached a terminal state. */
async function settled(queue: { value: DownloadEntry[] }): Promise<void> {
  for (let tick = 0; tick < 100; tick += 1) {
    if (queue.value.every((entry) => entry.status === "done" || entry.status === "error")) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("useDownloads", () => {
  beforeEach(() => {
    localStorage.clear();
    renderWatermarked.mockClear();
    saveBlob.mockClear();
    setCameraTransport(respondWith(CAMERA_BYTES));
  });

  afterEach(() => {
    resetCameraTransport();
    clearNuxtState(
      [
        "download-queue",
        "download-running",
        "watermark-settings",
        "camera-library",
        "camera-host",
        "camera-status",
        "camera-info",
        "camera-error",
        "camera-library-loading",
        "camera-want-connection",
        "camera-retry-attempt",
      ],
      { reset: true },
    );
  });

  it("records the transferred byte count on an entry the file list left at zero", async () => {
    const downloads = await mountComposable(() => useDownloads());
    downloads.enqueue([makeMediaItem({ size: 0 })], { watermark: false });
    await settled(downloads.queue);

    const entry = downloads.queue.value[0]!;
    expect(entry.status).toBe("done");
    expect(entry.item.size).toBe(CAMERA_BYTES);
  });

  it("backfills the size onto the shared library item, not just the queue entry", async () => {
    const { camera, downloads } = await mountComposable(() => ({
      camera: useCamera(),
      downloads: useDownloads(),
    }));
    camera.library.value = [makeMediaItem({ size: 0 })];
    // The gallery can hand over a copy, so the entry and the library item are
    // not guaranteed to be the same object.
    downloads.enqueue([{ ...camera.library.value[0]! }], { watermark: false });
    await settled(downloads.queue);

    expect(camera.library.value[0]!.size).toBe(CAMERA_BYTES);
  });

  it("records the camera file's size, not the watermarked output's", async () => {
    const downloads = await mountComposable(() => useDownloads());
    downloads.enqueue([makeMediaItem({ size: 0 })], { watermark: true });
    await settled(downloads.queue);

    expect(renderWatermarked).toHaveBeenCalled();
    expect(downloads.queue.value[0]!.item.size).not.toBe(WATERMARKED_BYTES);
    expect(downloads.queue.value[0]!.item.size).toBe(CAMERA_BYTES);
  });

  it("replaces an index-estimated size with the exact byte count", async () => {
    const downloads = await mountComposable(() => useDownloads());
    downloads.enqueue([makeMediaItem({ size: 18 * 1024 * 1024 })], { watermark: false });
    await settled(downloads.queue);

    expect(downloads.queue.value[0]!.item.size).toBe(CAMERA_BYTES);
  });

  it("leaves the size untouched when the transfer fails", async () => {
    setCameraTransport(
      makeFakeTransport({
        fetch: vi.fn(async () => new Response(null, { status: 404 })),
      }),
    );

    const downloads = await mountComposable(() => useDownloads());
    downloads.enqueue([makeMediaItem({ size: 0 })], { watermark: false });
    await settled(downloads.queue);

    const entry = downloads.queue.value[0]!;
    expect(entry.status).toBe("error");
    expect(entry.item.size).toBe(0);
  });

  it("watermarks renderable photos", async () => {
    const downloads = await mountComposable(() => useDownloads());

    downloads.enqueue([makeMediaItem({ id: "jpg", name: "IMG_0001.jpg" })], { watermark: true });
    await settled(downloads.queue);

    expect(renderWatermarked).toHaveBeenCalledTimes(1);
    expect(downloads.queue.value[0]?.status).toBe("done");
  });

  it("saves RAW photos unmodified instead of pretending to watermark them", async () => {
    const downloads = await mountComposable(() => useDownloads());

    downloads.enqueue(
      [makeMediaItem({ id: "dng", name: "IMG_0001.dng", ext: "dng", renderable: false })],
      { watermark: true },
    );
    await settled(downloads.queue);

    expect(renderWatermarked).not.toHaveBeenCalled();
    expect(saveBlob).toHaveBeenCalledTimes(1);
    expect(downloads.queue.value[0]?.status).toBe("done");
  });

  it("never watermarks videos", async () => {
    const downloads = await mountComposable(() => useDownloads());

    downloads.enqueue([makeMediaItem({ id: "mp4", name: "VID_0001.mp4", type: "video" })], {
      watermark: true,
    });
    await settled(downloads.queue);

    expect(renderWatermarked).not.toHaveBeenCalled();
  });

  it("fails the download when watermarking a renderable photo throws", async () => {
    renderWatermarked.mockRejectedValueOnce(new Error("watermark render failed"));
    const downloads = await mountComposable(() => useDownloads());

    downloads.enqueue([makeMediaItem({ id: "jpg", name: "IMG_0001.jpg" })], { watermark: true });
    await settled(downloads.queue);

    expect(saveBlob).not.toHaveBeenCalled();
    expect(downloads.queue.value[0]?.status).toBe("error");
    expect(downloads.queue.value[0]?.error).toBe("watermark render failed");
  });
});
