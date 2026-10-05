import { beforeEach, describe, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => {
  const written: Uint8Array[] = [];
  const file = {
    write: vi.fn(async (chunk: Uint8Array) => {
      written.push(chunk);
      return chunk.byteLength;
    }),
    close: vi.fn(async () => {}),
  };
  return {
    written,
    file,
    create: vi.fn(async (_path: string, _options?: unknown) => file),
    mkdir: vi.fn(async () => {}),
    rename: vi.fn(async (_from: string, _to: string, _options?: unknown) => {}),
    remove: vi.fn(async (_path: string, _options?: unknown) => {}),
    BaseDirectory: { Download: 7 },
  };
});

vi.mock("@tauri-apps/plugin-fs", () => fs);
vi.mock("~/utils/saveFile", () => ({ isTauri: () => true, saveBlob: vi.fn() }));

const { TransferStalledError, readCameraBody, streamCameraFileToDisk } =
  await import("~/utils/streamDownload");

function bodyOf(chunks: Uint8Array[], { hangAfter = false } = {}): Response {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]!);
      } else if (!hangAfter) {
        controller.close();
      }
      // hangAfter: never enqueue or close, like a camera that went silent.
      return hangAfter && index >= chunks.length ? new Promise(() => {}) : undefined;
    },
  });
  return new Response(stream, { status: 200 });
}

function failingBody(): Response {
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.error(new Error("connection reset"));
        return;
      }
      sent = true;
      controller.enqueue(new Uint8Array(10));
    },
  });
  return new Response(stream, { status: 200 });
}

describe("streamCameraFileToDisk", () => {
  beforeEach(() => {
    fs.written.length = 0;
    for (const fn of [fs.create, fs.mkdir, fs.rename, fs.remove, fs.file.write, fs.file.close]) {
      fn.mockClear();
    }
  });

  it("writes to a .part file and renames it into place once complete", async () => {
    const response = bodyOf([new Uint8Array(3), new Uint8Array(5)]);

    const result = await streamCameraFileToDisk(response, "VID_1.mp4");

    expect(fs.create.mock.calls[0]![0]).toBe("Luna Ultra/VID_1.mp4.part");
    expect(fs.rename.mock.calls[0]!.slice(0, 2)).toEqual([
      "Luna Ultra/VID_1.mp4.part",
      "Luna Ultra/VID_1.mp4",
    ]);
    expect(fs.remove).not.toHaveBeenCalled();
    expect(result).toEqual({ savedTo: "Downloads/Luna Ultra/VID_1.mp4", size: 8 });
  });

  it("deletes the partial file and never renames it when the stream fails", async () => {
    await expect(streamCameraFileToDisk(failingBody(), "VID_1.mp4")).rejects.toThrow(
      "connection reset",
    );

    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.remove.mock.calls[0]![0]).toBe("Luna Ultra/VID_1.mp4.part");
    expect(fs.file.close).toHaveBeenCalled();
  });

  it("gives up and cleans up when the camera stops sending", async () => {
    const response = bodyOf([new Uint8Array(4)], { hangAfter: true });

    await expect(
      streamCameraFileToDisk(response, "VID_1.mp4", undefined, { stallMs: 20 }),
    ).rejects.toBeInstanceOf(TransferStalledError);

    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.remove.mock.calls[0]![0]).toBe("Luna Ultra/VID_1.mp4.part");
  });

  it("reports progress against content-length", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(6));
          controller.enqueue(new Uint8Array(4));
          controller.close();
        },
      }),
      { headers: { "content-length": "10" } },
    );
    const progress: Array<[number, number | null]> = [];

    await streamCameraFileToDisk(response, "VID_1.mp4", (written, total) =>
      progress.push([written, total]),
    );

    expect(progress).toEqual([
      [6, 10],
      [10, 10],
    ]);
  });
});

describe("readCameraBody", () => {
  it("collects every chunk into one blob", async () => {
    const blob = await readCameraBody(bodyOf([new Uint8Array(2), new Uint8Array(7)]));
    expect(blob.size).toBe(9);
  });

  it("calls onChunk for each chunk received", async () => {
    const onChunk = vi.fn();
    await readCameraBody(bodyOf([new Uint8Array(2), new Uint8Array(7)]), { onChunk });
    expect(onChunk).toHaveBeenCalledTimes(2);
  });

  it("rejects instead of hanging when the camera goes silent", async () => {
    const response = bodyOf([new Uint8Array(2)], { hangAfter: true });
    await expect(readCameraBody(response, { stallMs: 20 })).rejects.toBeInstanceOf(
      TransferStalledError,
    );
  });
});
