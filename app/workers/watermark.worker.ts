/// <reference lib="webworker" />
import { WATERMARK_ASSET_URL } from "../utils/watermark";
import type { WatermarkPosition } from "../utils/watermark";
import { composeWatermarked } from "../utils/watermarkCompose";

export interface WatermarkRequest {
  id: number;
  blob: Blob;
  position: WatermarkPosition;
  quality: number;
}

export interface WatermarkResponse {
  id: number;
  blob?: Blob;
  error?: string;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

/**
 * The watermark asset never changes, so decode it once and keep the bitmap for
 * the worker's lifetime — a batch download would otherwise re-fetch and
 * re-decode the same PNG for every photo.
 */
let markPromise: Promise<ImageBitmap> | null = null;

function watermarkBitmap(): Promise<ImageBitmap> {
  markPromise ??= (async () => {
    const response = await fetch(WATERMARK_ASSET_URL);
    if (!response.ok) throw new Error(`watermark asset ${response.status}`);
    return await createImageBitmap(await response.blob());
  })().catch((cause: unknown) => {
    // Clear the cache so a transient failure stays retryable rather than
    // poisoning every later download in the batch.
    markPromise = null;
    throw cause;
  });
  return markPromise;
}

scope.onmessage = async (event: MessageEvent<WatermarkRequest>) => {
  const { id, blob, position, quality } = event.data;
  let source: ImageBitmap | null = null;
  try {
    const [decoded, mark] = await Promise.all([createImageBitmap(blob), watermarkBitmap()]);
    source = decoded;
    const out = await composeWatermarked(decoded, mark, position, quality);
    scope.postMessage({ id, blob: out } satisfies WatermarkResponse);
  } catch (cause) {
    scope.postMessage({
      id,
      error: cause instanceof Error ? cause.message : String(cause),
    } satisfies WatermarkResponse);
  } finally {
    source?.close();
  }
};
