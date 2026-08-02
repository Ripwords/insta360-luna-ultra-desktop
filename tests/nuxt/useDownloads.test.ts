import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadEntry } from "~/types/media";
import { resetCameraTransport, setCameraTransport } from "~/utils/transport";
import { makeFakeTransport } from "../helpers/fakeTransport";
import { makeMediaItem } from "../helpers/media";
import { mountComposable } from "./harness";

const renderWatermarked = vi.hoisted(() => vi.fn(async (blob: Blob) => blob));
const saveBlob = vi.hoisted(() => vi.fn(async () => "Downloads/Luna Ultra/file"));

vi.mock("~/utils/watermarkClient", () => ({ renderWatermarked }));
vi.mock("~/utils/saveFile", () => ({ saveBlob, isTauri: () => false }));

mockNuxtImport("useToast", () => () => ({
  add: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  clear: vi.fn(),
  toasts: [],
}));

/** Wait for the queue drain kicked off by `enqueue` to settle. */
async function settled(queue: { value: DownloadEntry[] }): Promise<void> {
  for (let tick = 0; tick < 50; tick++) {
    if (queue.value.every((entry) => entry.status === "done" || entry.status === "error")) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("useDownloads", () => {
  beforeEach(() => {
    renderWatermarked.mockClear();
    saveBlob.mockClear();
    setCameraTransport(
      makeFakeTransport({
        fetch: vi.fn(async () => new Response(new Blob(["photo-bytes"]), { status: 200 })),
      }),
    );
  });

  afterEach(() => {
    resetCameraTransport();
    clearNuxtState(["download-queue", "download-running", "watermark-settings"], { reset: true });
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
