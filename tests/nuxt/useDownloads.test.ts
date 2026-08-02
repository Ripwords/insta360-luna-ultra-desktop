import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCameraTransport, setCameraTransport } from "~/utils/transport";
import { makeFakeTransport } from "../helpers/fakeTransport";
import { makeMediaItem } from "../helpers/media";
import { mountComposable } from "./harness";

vi.mock("~/utils/saveFile", () => ({
  isTauri: () => false,
  saveBlob: vi.fn(async (_blob: Blob, fileName: string) => `Downloads/Luna Ultra/${fileName}`),
}));

const renderWatermarked = vi.fn(async (_blob: Blob, _settings: unknown) =>
  bodyOf(WATERMARKED_BYTES),
);
vi.mock("~/utils/watermarkClient", () => ({
  renderWatermarked: (blob: Blob, settings: unknown) => renderWatermarked(blob, settings),
}));

const CAMERA_BYTES = 4096;
const WATERMARKED_BYTES = 9000;

function bodyOf(bytes: number): Blob {
  return new Blob([new Uint8Array(bytes)]);
}

function respondWith(bytes: number) {
  // Uint8Array rather than a Blob body: this environment's Response
  // stringifies a Blob instead of streaming it.
  return makeFakeTransport({
    fetch: vi.fn(async () => new Response(new Uint8Array(bytes), { status: 200 })),
  });
}

/** Resolve once every queued transfer has left the queue's active states. */
async function drain(active: { value: unknown[] }) {
  for (let tick = 0; tick < 100 && active.value.length > 0; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("useDownloads", () => {
  beforeEach(() => {
    localStorage.clear();
    renderWatermarked.mockClear();
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
    setCameraTransport(respondWith(CAMERA_BYTES));

    const downloads = await mountComposable(() => useDownloads());
    downloads.enqueue([makeMediaItem({ size: 0 })], { watermark: false });
    await drain(downloads.active);

    const entry = downloads.queue.value[0]!;
    expect(entry.status).toBe("done");
    expect(entry.item.size).toBe(CAMERA_BYTES);
  });

  it("backfills the size onto the shared library item, not just the queue entry", async () => {
    setCameraTransport(respondWith(CAMERA_BYTES));

    const { camera, downloads } = await mountComposable(() => ({
      camera: useCamera(),
      downloads: useDownloads(),
    }));
    camera.library.value = [makeMediaItem({ size: 0 })];
    // The gallery can hand over a copy, so the entry and the library item are
    // not guaranteed to be the same object.
    downloads.enqueue([{ ...camera.library.value[0]! }], { watermark: false });
    await drain(downloads.active);

    expect(camera.library.value[0]!.size).toBe(CAMERA_BYTES);
  });

  it("records the camera file's size, not the watermarked output's", async () => {
    setCameraTransport(respondWith(CAMERA_BYTES));

    const downloads = await mountComposable(() => useDownloads());
    downloads.enqueue([makeMediaItem({ size: 0 })], { watermark: true });
    await drain(downloads.active);

    expect(renderWatermarked).toHaveBeenCalled();
    expect(downloads.queue.value[0]!.item.size).toBe(CAMERA_BYTES);
  });

  it("replaces an index-estimated size with the exact byte count", async () => {
    setCameraTransport(respondWith(CAMERA_BYTES));

    const downloads = await mountComposable(() => useDownloads());
    downloads.enqueue([makeMediaItem({ size: 18 * 1024 * 1024 })], { watermark: false });
    await drain(downloads.active);

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
    await drain(downloads.active);

    const entry = downloads.queue.value[0]!;
    expect(entry.status).toBe("error");
    expect(entry.item.size).toBe(0);
  });
});
