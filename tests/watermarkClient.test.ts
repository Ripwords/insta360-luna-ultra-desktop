import { describe, expect, it } from "vitest";
import { DEFAULT_WATERMARK, type WatermarkSettings } from "~/utils/watermark";
import { lastWatermarkPath, renderWatermarked } from "~/utils/watermarkClient";

/**
 * No Worker, no OffscreenCanvas and no createImageBitmap here, so every render
 * attempt takes the main-thread path and fails there — which is exactly the
 * shape of the RAW failure this file guards against being swallowed.
 */
const OFF: WatermarkSettings = { ...DEFAULT_WATERMARK, enabled: false };

function photoBlob(): Blob {
  return new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
}

describe("renderWatermarked", () => {
  it("returns the original blob untouched when watermarking is off", async () => {
    const blob = photoBlob();
    await expect(renderWatermarked(blob, OFF)).resolves.toBe(blob);
    expect(lastWatermarkPath()).toBe("passthrough");
  });

  it("rejects instead of silently returning an unwatermarked blob when the render fails", async () => {
    await expect(renderWatermarked(photoBlob(), DEFAULT_WATERMARK)).rejects.toThrow();
  });
});
