import { isTauri, saveBlob } from "~/utils/saveFile";

export interface StreamedDownload {
  savedTo: string;
  size: number;
}

/**
 * Stream a camera HTTP response straight to disk, one chunk at a time,
 * instead of buffering the whole body in the webview's memory first (as
 * `response.blob()` / `response.arrayBuffer()` do).
 *
 * A full-resolution 8K video can run several GB. `@tauri-apps/plugin-http`'s
 * Response.body is a genuine incremental stream — every read pulls exactly
 * one more chunk over IPC from the Rust side (see its `fetch_read_body`
 * command) rather than the whole thing arriving at once — but `.blob()`
 * still drains that stream to completion into a single in-memory buffer
 * before resolving. For a multi-GB file that has been observed to exhaust
 * the webview process: the window goes blank mid-download, the process
 * having crashed, and nothing is ever written to disk. Reading the stream
 * directly and writing each chunk out as it arrives keeps memory bounded to
 * one chunk regardless of file size.
 *
 * Scoped to videos in `useDownloads` for now: photos still need the whole
 * buffer in memory for the watermark canvas (or, for RAW, to seed the
 * preview cache from the downloaded bytes), and are far smaller than an 8K
 * video in practice. This same helper would apply to photos too if a future
 * change reworks those paths to not need an in-memory copy.
 */
export async function streamCameraFileToDisk(
  response: Response,
  fileName: string,
  onProgress?: (writtenBytes: number, totalBytes: number | null) => void,
): Promise<StreamedDownload> {
  const totalHeader = response.headers.get("content-length");
  const total = totalHeader ? Number(totalHeader) : null;

  if (!response.body || !isTauri()) {
    // No real streaming body to read (e.g. the docs-site mock transport
    // running in a plain browser, or a server that didn't send one) — fall
    // back to the simple whole-file approach rather than failing outright.
    const blob = await response.blob();
    const savedTo = await saveBlob(blob, fileName);
    onProgress?.(blob.size, blob.size);
    return { savedTo, size: blob.size };
  }

  const { create, mkdir, BaseDirectory } = await import("@tauri-apps/plugin-fs");
  await mkdir("Luna Ultra", { baseDir: BaseDirectory.Download, recursive: true });
  const path = `Luna Ultra/${fileName}`;
  const file = await create(path, { baseDir: BaseDirectory.Download });

  const reader = response.body.getReader();
  let written = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        await file.write(value);
        written += value.byteLength;
        onProgress?.(written, total);
      }
    }
  } finally {
    await file.close();
  }

  return { savedTo: `Downloads/${path}`, size: written };
}
