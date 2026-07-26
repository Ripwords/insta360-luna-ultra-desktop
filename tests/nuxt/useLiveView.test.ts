import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCameraTransport, setCameraTransport } from "~/utils/transport";
import { makeFakeTransport } from "../helpers/fakeTransport";
import { mountComposable } from "./harness";

describe("useLiveView", () => {
  beforeEach(() => {
    localStorage.clear();
    clearNuxtState(["camera-host"], { reset: true });
  });

  afterEach(() => {
    resetCameraTransport();
    clearNuxtState([
      "camera-status",
      "camera-info",
      "camera-library",
      "camera-error",
      "camera-library-loading",
      "camera-want-connection",
      "camera-retry-attempt",
      "liveview-active",
      "liveview-starting",
      "liveview-transport",
      "liveview-url",
      "liveview-error",
      "liveview-diagnostics",
    ]);
  });

  it("prefers an OSC MJPEG preview when the camera offers one", async () => {
    const transport = makeFakeTransport({
      probeOscPreview: vi.fn(async () => "http://cam/osc/commands/execute"),
    });
    setCameraTransport(transport);

    const { camera, live } = await mountComposable(() => ({
      camera: useCamera(),
      live: useLiveView(),
    }));
    await camera.connect();
    await live.start();

    expect(live.transport.value).toBe("mjpeg");
    expect(live.streamUrl.value).toBe("http://cam/osc/commands/execute");
    expect(transport.liveViewStart).not.toHaveBeenCalled();
  });

  it("falls back to the control-session annexb stream", async () => {
    const transport = makeFakeTransport();
    setCameraTransport(transport);

    const { camera, live } = await mountComposable(() => ({
      camera: useCamera(),
      live: useLiveView(),
    }));
    await camera.connect();
    await live.start();

    expect(live.transport.value).toBe("annexb");
    expect(live.streamUrl.value).toBe("http://127.0.0.1:9000/live");
  });

  it("refuses to start when the camera is not connected", async () => {
    setCameraTransport(makeFakeTransport());

    const live = await mountComposable(() => useLiveView());
    await live.start();

    expect(live.active.value).toBe(false);
    expect(live.error.value).toBe("Connect to the camera first.");
  });

  it("stops through the transport and clears the stream", async () => {
    const transport = makeFakeTransport();
    setCameraTransport(transport);

    const { camera, live } = await mountComposable(() => ({
      camera: useCamera(),
      live: useLiveView(),
    }));
    await camera.connect();
    await live.start();
    await live.stop();

    expect(transport.liveViewStop).toHaveBeenCalled();
    expect(live.active.value).toBe(false);
    expect(live.streamUrl.value).toBeNull();
  });
});
