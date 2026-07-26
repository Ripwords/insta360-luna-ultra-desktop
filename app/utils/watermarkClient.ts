import { drawWatermark } from "~/utils/watermark";
import type { WatermarkSettings } from "~/utils/watermark";
import { WATERMARK_JPEG_QUALITY } from "~/utils/watermarkCompose";
import type { WatermarkRequest, WatermarkResponse } from "~/workers/watermark.worker";

/**
 * Applies the official watermark to a downloaded photo, off the main thread
 * where the platform allows it.
 *
 * Watermarking means decoding, re-drawing and re-encoding the photo at full
 * resolution; doing that inline froze the UI for the duration of every
 * watermarked file in a batch. A single worker is reused across the batch (so
 * the watermark PNG is decoded once), and anything that stops it working —
 * no worker support, no OffscreenCanvas, a crash mid-batch — falls back to the
 * original main-thread path rather than failing the download.
 */

/** Which route the last render actually took. */
export type WatermarkPath = "worker" | "main-thread" | "passthrough";

let lastPath: WatermarkPath = "passthrough";

/**
 * How the most recent watermark was rendered. Worth exposing because the
 * fallback is silent by design: a platform that quietly rejects the worker
 * would reintroduce the main-thread freeze with nothing else to show for it.
 */
export function lastWatermarkPath(): WatermarkPath {
  return lastPath;
}

let worker: Worker | null = null;
let workerUnusable = false;
let nextRequestId = 0;
const pending = new Map<
  number,
  { resolve: (blob: Blob) => void; reject: (cause: Error) => void }
>();

/** Give up on the worker for the rest of the session and fail everything queued. */
function retireWorker(cause: Error): void {
  workerUnusable = true;
  worker?.terminate();
  worker = null;
  for (const entry of pending.values()) entry.reject(cause);
  pending.clear();
}

function ensureWorker(): Worker | null {
  if (workerUnusable) return null;
  if (worker) return worker;
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
    workerUnusable = true;
    return null;
  }
  try {
    worker = new Worker(new URL("../workers/watermark.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<WatermarkResponse>) => {
      const { id, blob, error } = event.data;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (blob) entry.resolve(blob);
      else entry.reject(new Error(error ?? "watermark failed"));
    };
    worker.onerror = () => retireWorker(new Error("watermark worker failed to start"));
  } catch {
    // Bundlers or platforms that reject module workers land here; the caller
    // falls back to rendering inline.
    workerUnusable = true;
    worker = null;
    return null;
  }
  return worker;
}

function requestFromWorker(active: Worker, blob: Blob, position: WatermarkSettings["position"]) {
  return new Promise<Blob>((resolve, reject) => {
    const id = nextRequestId++;
    pending.set(id, { resolve, reject });
    const request: WatermarkRequest = { id, blob, position, quality: WATERMARK_JPEG_QUALITY };
    active.postMessage(request);
  });
}

/** The original inline path, kept as the fallback. */
async function renderOnMainThread(blob: Blob, settings: WatermarkSettings): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    return blob;
  }
  context.drawImage(bitmap, 0, 0);
  await drawWatermark(context, bitmap.width, bitmap.height, settings);
  bitmap.close();
  return await new Promise<Blob>((resolve) => {
    canvas.toBlob((out) => resolve(out ?? blob), "image/jpeg", WATERMARK_JPEG_QUALITY);
  });
}

/**
 * Return `blob` with the watermark applied. Returns the original untouched
 * when watermarking is off — no point paying a re-encode to change nothing —
 * and on any rendering failure, so a download never fails over decoration.
 */
export async function renderWatermarked(blob: Blob, settings: WatermarkSettings): Promise<Blob> {
  if (!settings.enabled) {
    lastPath = "passthrough";
    return blob;
  }

  const active = ensureWorker();
  if (active) {
    try {
      const out = await requestFromWorker(active, blob, settings.position);
      lastPath = "worker";
      return out;
    } catch {
      // Fall through to the main thread; the worker may be gone for good.
    }
  }

  try {
    const out = await renderOnMainThread(blob, settings);
    lastPath = "main-thread";
    return out;
  } catch {
    lastPath = "passthrough";
    return blob;
  }
}
