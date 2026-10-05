import { isTauri, saveBlob } from "~/utils/saveFile";

/**
 * How long a transfer may go without receiving anything before it is given up.
 * The HTTP plugin has no read timeout, so a camera that dies mid-file would
 * otherwise leave the download waiting forever.
 */
export const TRANSFER_STALL_MS = 30_000;

export class TransferStalledError extends Error {
  constructor() {
    super("The camera stopped sending data");
    this.name = "TransferStalledError";
  }
}

export interface StreamedDownload {
  savedTo: string;
  size: number;
}

interface ReadOptions {
  onChunk?: (chunk: Uint8Array) => void;
  stallMs?: number;
}

/** Settle with `promise`, or reject with `TransferStalledError` after `ms`. */
export function withStallTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onStall?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stall = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject first: cancelling a stream settles its pending read as `done`
      // synchronously, which would otherwise win the race as a clean end.
      reject(new TransferStalledError());
      onStall?.();
    }, ms);
  });
  return Promise.race([promise, stall]).finally(() => clearTimeout(timer));
}

async function forEachChunk(
  body: ReadableStream<Uint8Array>,
  stallMs: number,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
): Promise<void> {
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await withStallTimeout(reader.read(), stallMs, () => {
      // Frees the body, but plugin-http's in-flight read keeps the camera
      // connection open until its next chunk arrives or TCP gives up.
      reader.cancel().catch(() => {});
    });
    if (done) return;
    if (value.byteLength > 0) await onChunk(value);
  }
}

/** Read a whole camera response into memory, failing rather than hanging if it stalls. */
export async function readCameraBody(
  response: Response,
  { onChunk, stallMs = TRANSFER_STALL_MS }: ReadOptions = {},
): Promise<Blob> {
  if (!response.body) return withStallTimeout(response.blob(), stallMs);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  await forEachChunk(response.body, stallMs, (chunk) => {
    chunks.push(new Uint8Array(chunk));
    onChunk?.(chunk);
  });
  return new Blob(chunks);
}

/**
 * Stream a camera response to disk one chunk at a time. `response.blob()`
 * holds the whole file in the webview's memory, and on a multi-GB 8K video
 * that has crashed the webview outright.
 *
 * Bytes go to `<name>.part` and are renamed into place only once complete, so
 * a failed transfer never leaves a truncated file under the real name.
 *
 * Only videos use this: photos need the whole buffer for the watermark canvas
 * or the RAW preview cache.
 */
export async function streamCameraFileToDisk(
  response: Response,
  fileName: string,
  onProgress?: (writtenBytes: number, totalBytes: number | null) => void,
  { stallMs = TRANSFER_STALL_MS }: { stallMs?: number } = {},
): Promise<StreamedDownload> {
  const totalHeader = response.headers.get("content-length");
  const total = totalHeader ? Number(totalHeader) : null;

  if (!response.body || !isTauri()) {
    // The docs-site mock in a plain browser: no fs plugin to stream into.
    const blob = await readCameraBody(response, { stallMs });
    const savedTo = await saveBlob(blob, fileName);
    onProgress?.(blob.size, blob.size);
    return { savedTo, size: blob.size };
  }

  const { create, mkdir, remove, rename, BaseDirectory } = await import("@tauri-apps/plugin-fs");
  const baseDir = BaseDirectory.Download;
  await mkdir("Luna Ultra", { baseDir, recursive: true });
  const path = `Luna Ultra/${fileName}`;
  const partPath = `${path}.part`;
  const file = await create(partPath, { baseDir });

  let written = 0;
  try {
    try {
      await forEachChunk(response.body, stallMs, async (chunk) => {
        await file.write(chunk);
        written += chunk.byteLength;
        onProgress?.(written, total);
      });
    } finally {
      await file.close();
    }
    await rename(partPath, path, { oldPathBaseDir: baseDir, newPathBaseDir: baseDir });
  } catch (error) {
    await remove(partPath, { baseDir }).catch(() => {});
    throw error;
  }

  return { savedTo: `Downloads/${path}`, size: written };
}
