import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCameraTransport, setCameraTransport } from "~/utils/transport";
import { makeFakeTransport } from "../helpers/fakeTransport";
import { makeMediaItem } from "../helpers/media";
import { mountComposable } from "./harness";

describe("useCamera", () => {
  beforeEach(() => {
    localStorage.clear();
    clearNuxtState(["camera-host"], { reset: true });
  });

  afterEach(() => {
    resetCameraTransport();
    clearNuxtState(
      [
        "camera-status",
        "camera-info",
        "camera-library",
        "camera-error",
        "camera-library-loading",
        "camera-want-connection",
        "camera-retry-attempt",
      ],
      { reset: true },
    );
  });

  it("connects through the active transport and loads the library", async () => {
    const transport = makeFakeTransport({
      listMedia: vi.fn(async () => [makeMediaItem()]),
    });
    setCameraTransport(transport);

    const camera = await mountComposable(() => useCamera());
    await camera.connect();

    expect(transport.connect).toHaveBeenCalledWith(camera.host.value);
    expect(camera.isConnected.value).toBe(true);
    expect(camera.library.value).toHaveLength(1);
  });

  it("reports unavailable transports instead of connecting", async () => {
    setCameraTransport(makeFakeTransport({ available: false }));

    const camera = await mountComposable(() => useCamera());
    await camera.connect();

    expect(camera.isConnected.value).toBe(false);
    expect(camera.error.value).toContain("desktop app");
  });

  it("surfaces a connect failure as an error, not a thrown exception", async () => {
    setCameraTransport(
      makeFakeTransport({
        connect: vi.fn(async () => {
          throw new Error("no route to host");
        }),
      }),
    );

    const camera = await mountComposable(() => useCamera());
    await expect(camera.connect()).resolves.toBeUndefined();
    expect(camera.error.value).toBe("no route to host");
    expect(camera.isConnected.value).toBe(false);
  });

  it("subscribes to disconnect through the transport, not Tauri directly", async () => {
    const transport = makeFakeTransport();
    setCameraTransport(transport);

    const camera = await mountComposable(() => useCamera());
    await camera.connect();

    expect(transport.onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("tears the session down on disconnect", async () => {
    const transport = makeFakeTransport();
    setCameraTransport(transport);

    const camera = await mountComposable(() => useCamera());
    await camera.connect();
    await camera.disconnect();

    expect(transport.disconnect).toHaveBeenCalled();
    expect(camera.isConnected.value).toBe(false);
    expect(camera.library.value).toEqual([]);
  });
});
