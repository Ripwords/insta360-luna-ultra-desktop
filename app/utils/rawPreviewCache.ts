import type { MediaItem } from "~/types/media";
import { cachedMedia, hasCachedMedia } from "./mediaCache";
import { extractDngPreview } from "./dng";
import { decodeRawToDataUrl } from "./rawCanvas";

/**
 * Cache key for a RAW's derived preview.
 *
 * Shared by RawImage (which derives it on demand) and the download path (which
 * seeds it from bytes already in hand) so the two can't drift apart and miss
 * each other's work. Every input that changes the derived output is in the key:
 * a range-limited grid thumbnail and a full-file preview are different
 * artifacts of the same source.
 */
export function rawPreviewKey(
  src: string,
  options: { maxBytes?: number; prefer?: "largest" | "smallest" } = {},
): string {
  const { maxBytes, prefer = "largest" } = options;
  return `raw:${src}:${maxBytes ?? "full"}:${prefer}`;
}

/** A photo the browser can't decode itself — i.e. RAW, which needs a preview. */
export function isRawPhoto(item: MediaItem): boolean {
  return item.type === "photo" && !item.renderable;
}

/**
 * Derive a RAW's preview from the file's own bytes and seed the media cache.
 *
 * A download already holds the whole file, so this costs no extra network and
 * no camera-queue slot — the alternative is re-fetching tens of MB to show a
 * thumbnail. Prefers an embedded preview JPEG and falls back to decoding the
 * Bayer sensor data (the Luna's DNGs carry no embedded preview).
 *
 * Returns the preview, or null when the file yields none. Never throws: a
 * cosmetic thumbnail must not be able to fail a download that already
 * succeeded.
 */
export async function cacheRawPreviewFromBlob(
  item: MediaItem,
  blob: Blob,
): Promise<string | Blob | null> {
  const key = rawPreviewKey(item.srcUrl);
  // The viewer may already have derived this; its value is as good as ours and
  // re-deriving would burn CPU to replace it with an identical result.
  if (hasCachedMedia(key)) return await cachedMedia(key, async () => null);

  return await cachedMedia(key, async () => {
    try {
      const buffer = await blob.arrayBuffer();
      const embedded = extractDngPreview(buffer, "largest");
      if (embedded) return embedded;
      return decodeRawToDataUrl(buffer);
    } catch {
      return null;
    }
  });
}
