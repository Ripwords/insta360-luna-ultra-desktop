import { describe, expect, it, vi, beforeEach } from "vitest";
import { rawPreviewKey, isRawPhoto, cacheRawPreviewFromBlob } from "~/utils/rawPreviewCache";
import { hasCachedMedia, cachedMedia, clearCachedMedia } from "~/utils/mediaCache";
import { makeMediaItem } from "./helpers/media";

vi.mock("~/utils/rawCanvas", () => ({
  decodeRawToDataUrl: vi.fn(() => "data:image/jpeg;base64,DECODED"),
}));

vi.mock("~/utils/dng", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/utils/dng")>();
  return { ...original, extractDngPreview: vi.fn(() => null) };
});

const raw = () => makeMediaItem({ id: "dng", name: "IMG_1.dng", ext: "dng", renderable: false });

describe("rawPreviewKey", () => {
  it("builds the full-file key the download seeds and the viewer reads", () => {
    expect(rawPreviewKey("http://cam/IMG_1.dng")).toBe("raw:http://cam/IMG_1.dng:full:largest");
  });

  it("keys a range-limited grid thumbnail apart from the full-file preview", () => {
    const thumb = rawPreviewKey("http://cam/IMG_1.dng", { maxBytes: 2000, prefer: "smallest" });
    expect(thumb).not.toBe(rawPreviewKey("http://cam/IMG_1.dng"));
  });
});

describe("isRawPhoto", () => {
  it("accepts a photo the browser cannot render", () => {
    expect(isRawPhoto(raw())).toBe(true);
  });

  it("rejects renderable photos and videos", () => {
    expect(isRawPhoto(makeMediaItem({ name: "IMG_1.jpg" }))).toBe(false);
    expect(isRawPhoto(makeMediaItem({ name: "VID_1.mp4", type: "video" }))).toBe(false);
  });
});

describe("cacheRawPreviewFromBlob", () => {
  beforeEach(() => {
    clearCachedMedia();
  });

  it("seeds a preview under the key the viewer will look up", async () => {
    const item = raw();
    await cacheRawPreviewFromBlob(item, new Blob([new Uint8Array(64)]));

    expect(hasCachedMedia(rawPreviewKey(item.srcUrl))).toBe(true);
    const cached = await cachedMedia(rawPreviewKey(item.srcUrl), async () => null);
    expect(cached).toBe("data:image/jpeg;base64,DECODED");
  });

  it("does not overwrite a preview the viewer already derived", async () => {
    const item = raw();
    await cachedMedia(rawPreviewKey(item.srcUrl), async () => "data:image/jpeg;base64,EXISTING");

    await cacheRawPreviewFromBlob(item, new Blob([new Uint8Array(64)]));

    const cached = await cachedMedia(rawPreviewKey(item.srcUrl), async () => null);
    expect(cached).toBe("data:image/jpeg;base64,EXISTING");
  });

  it("resolves without throwing when the file yields no preview", async () => {
    const { decodeRawToDataUrl } = await import("~/utils/rawCanvas");
    vi.mocked(decodeRawToDataUrl).mockReturnValueOnce(null);

    await expect(cacheRawPreviewFromBlob(raw(), new Blob([new Uint8Array(8)]))).resolves.toBeNull();
  });
});
