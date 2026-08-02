import { parseRawImageMeta, decodeRawPreview } from "./rawPreview";

/**
 * Render an uncompressed CFA RAW (e.g. Insta360 Luna DNG) to a preview JPEG
 * data URL via canvas. Synchronous encode (toDataURL) is used deliberately: it
 * can't leave us waiting on a canvas.toBlob callback that never fires. Returns
 * null when the file isn't a supported raw or the canvas is unavailable.
 *
 * Browser only — split out of RawImage.vue so the download path can derive the
 * same preview from bytes it already holds, without mounting a component.
 */
export function decodeRawToDataUrl(buffer: ArrayBuffer, maxEdge = 1600): string | null {
  try {
    const meta = parseRawImageMeta(buffer);
    if (!meta) return null;
    const decoded = decodeRawPreview(buffer, meta, maxEdge);
    if (!decoded) return null;
    const canvas = document.createElement("canvas");
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.putImageData(new ImageData(decoded.data, decoded.width, decoded.height), 0, 0);
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    // An allocation or canvas failure must read as decode-failed, not no-preview.
    return null;
  }
}
