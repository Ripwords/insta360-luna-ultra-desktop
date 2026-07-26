import { watermarkRect } from "./watermark";
import type { WatermarkPosition } from "./watermark";

/** Quality for the re-encode a watermarked download necessarily costs. */
export const WATERMARK_JPEG_QUALITY = 0.92;

/**
 * Composite the watermark over a decoded photo and encode the result.
 *
 * Deliberately built on `OffscreenCanvas` rather than a DOM canvas: the whole
 * composite — a full-resolution blit plus a JPEG encode of what can be a 50 MP
 * photo — is heavy enough to freeze the UI for the length of every watermarked
 * download, and only OffscreenCanvas can run it inside a worker. Keeping it
 * here rather than in the worker means the main thread can still use it as a
 * fallback on platforms without worker support.
 */
export async function composeWatermarked(
  source: ImageBitmap,
  mark: ImageBitmap,
  position: WatermarkPosition,
  quality: number = WATERMARK_JPEG_QUALITY,
): Promise<Blob> {
  const canvas = new OffscreenCanvas(source.width, source.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("OffscreenCanvas 2D context unavailable");
  context.drawImage(source, 0, 0);
  const rect = watermarkRect(source.width, source.height, position);
  context.drawImage(mark, rect.x, rect.y, rect.width, rect.height);
  return await canvas.convertToBlob({ type: "image/jpeg", quality });
}
