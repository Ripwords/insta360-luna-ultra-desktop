import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadEntry, WebcamStatus } from "~/types/media";
import { resetCameraTransport, setCameraTransport } from "~/utils/transport";
import { makeFakeTransport } from "../helpers/fakeTransport";
import { makeMediaItem } from "../helpers/media";
import { mountComposable } from "./harness";

const STREAMING: WebcamStatus = {
  state: "streaming",
  url: "http://127.0.0.1:49283/webcam.ts",
  codec: "H.265",
  width: 1280,
  height: 720,
  clients: 1,
  secondsSinceFrame: 0.1,
};

function setup(overrides: Parameters<typeof makeFakeTransport>[0] = {}) {
  const transport = makeFakeTransport({
    webcamStart: vi.fn(async () => STREAMING),
    webcamStop: vi.fn(async () => {}),
    webcamStatus: vi.fn(async () => STREAMING),
    ...overrides,
  });
  setCameraTransport(transport);
  return transport;
}

describe("useWebcam", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearNuxtState(["camera-host"], { reset: true });
  });

  afterEach(() => {
    vi.useRealTimers();
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
        "download-queue",
        "webcam-enabled",
        "webcam-status",
        "webcam-error",
      ],
      { reset: true },
    );
  });

  it("turns on and polls status every second", async () => {
    const transport = setup();
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();
    await webcam.turnOn();

    expect(webcam.enabled.value).toBe(true);
    expect(transport.webcamStart).toHaveBeenCalledTimes(1);
    expect(webcam.status.value).toEqual(STREAMING);

    await vi.advanceTimersByTimeAsync(3000);
    expect(transport.webcamStatus).toHaveBeenCalledTimes(3);
    await webcam.turnOff();
  });

  it("refuses while a download is queued", async () => {
    const transport = setup();
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();
    const queue = useState<DownloadEntry[]>("download-queue");
    queue.value = [
      { id: "a", item: makeMediaItem(), status: "queued", progress: 0 } as DownloadEntry,
    ];
    await webcam.turnOn();

    expect(webcam.error.value).toBe("Finish or cancel your downloads first.");
    expect(webcam.enabled.value).toBe(false);
    expect(transport.webcamStart).not.toHaveBeenCalled();
  });

  it("resumes after a reconnect", async () => {
    const transport = setup();
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();
    await webcam.turnOn();

    const status = useState<string>("camera-status");
    status.value = "disconnected";
    await nextTick();
    status.value = "connected";
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.webcamStart).toHaveBeenCalledTimes(2);
    expect(webcam.enabled.value).toBe(true);
    await webcam.turnOff();
  });

  it("shows stopped while disconnected", async () => {
    setup();
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();
    await webcam.turnOn();

    useState<string>("camera-status").value = "disconnected";
    await nextTick();

    expect(webcam.status.value?.state).toBe("stopped");
    expect(webcam.enabled.value).toBe(true);
    await webcam.turnOff();
  });

  it("turnOff stops polling and calls webcamStop", async () => {
    const transport = setup();
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();
    await webcam.turnOn();
    await webcam.turnOff();

    expect(transport.webcamStop).toHaveBeenCalledTimes(1);
    expect(webcam.enabled.value).toBe(false);
    const calls = vi.mocked(transport.webcamStatus).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.webcamStatus).toHaveBeenCalledTimes(calls);
  });

  it("keeps the message when start rejects with a bare string", async () => {
    setup({ webcamStart: vi.fn(async () => Promise.reject("camera is not connected")) });
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();
    await webcam.turnOn();

    expect(webcam.error.value).toBe("camera is not connected");
    await webcam.turnOff();
  });
});
