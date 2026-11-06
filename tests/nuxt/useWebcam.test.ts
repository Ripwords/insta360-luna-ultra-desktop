import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadEntry, WebcamStatus } from "~/types/media";
import { FAILURE_THRESHOLD, reportCameraFailure } from "~/utils/cameraHealth";
import { isCameraQueueHeld, setCameraQueueHeld } from "~/utils/cameraQueue";
import { resetCameraTransport, setCameraTransport } from "~/utils/transport";
import { makeFakeTransport } from "../helpers/fakeTransport";
import { makeDownloadEntry } from "../helpers/media";
import { mountSuspended } from "@nuxt/test-utils/runtime";
import { defineComponent } from "vue";
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
  // Most tests start from a fresh app; the seeding tests clear this themselves.
  useState<boolean>("webcam-seeded").value = true;
  return transport;
}

const STALLED: WebcamStatus = { ...STREAMING, state: "stalled" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flip the camera's connection the way the auto-reconnect does. */
async function reconnect() {
  const status = useState<string>("camera-status");
  status.value = "disconnected";
  await nextTick();
  status.value = "connected";
  await nextTick();
  await vi.advanceTimersByTimeAsync(0);
}

describe("useWebcam", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearNuxtState(["camera-host"], { reset: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    setCameraQueueHeld(false);
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
        "webcam-seeded",
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
    queue.value = [makeDownloadEntry({ id: "a" })];
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

  it("holds the camera queue while on and releases it on turn-off", async () => {
    setup();
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();
    expect(isCameraQueueHeld()).toBe(false);

    await webcam.turnOn();
    expect(isCameraQueueHeld()).toBe(true);

    await webcam.turnOff();
    expect(isCameraQueueHeld()).toBe(false);
  });

  it("leaves the camera queue released when start fails", async () => {
    setup({ webcamStart: vi.fn(async () => Promise.reject(new Error("busy"))) });
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();
    await webcam.turnOn();

    expect(webcam.enabled.value).toBe(false);
    expect(isCameraQueueHeld()).toBe(false);
  });

  it("discards a start that resolves after turn-off, and stops it on the camera", async () => {
    const start = deferred<WebcamStatus>();
    const transport = setup({ webcamStart: vi.fn(() => start.promise) });
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();

    const turningOn = webcam.turnOn();
    await webcam.turnOff();
    start.resolve(STREAMING);
    await turningOn;

    expect(webcam.status.value).toBeNull();
    expect(webcam.enabled.value).toBe(false);
    expect(isCameraQueueHeld()).toBe(false);
    // Once by turnOff, once more for the start that landed after it.
    expect(transport.webcamStop).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.webcamStatus).not.toHaveBeenCalled();
  });

  it("discards a reconnect start that resolves after turn-off", async () => {
    const transport = setup();
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();
    await webcam.turnOn();

    const restart = deferred<WebcamStatus>();
    vi.mocked(transport.webcamStart).mockImplementationOnce(() => restart.promise);
    await reconnect();
    await webcam.turnOff();
    restart.resolve(STREAMING);
    await vi.advanceTimersByTimeAsync(0);

    expect(webcam.status.value).toBeNull();
    expect(transport.webcamStop).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(transport.webcamStatus).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.webcamStatus).toHaveBeenCalledTimes(calls);
  });

  it("discards a poll result from before a turn-off and turn-on", async () => {
    const stale = deferred<WebcamStatus>();
    const transport = setup();
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();
    await webcam.turnOn();

    vi.mocked(transport.webcamStatus).mockImplementationOnce(() => stale.promise);
    await vi.advanceTimersByTimeAsync(1000);
    await webcam.turnOff();
    await webcam.turnOn();
    stale.resolve(STALLED);
    await vi.advanceTimersByTimeAsync(0);

    expect(webcam.status.value).toEqual(STREAMING);
    await webcam.turnOff();
  });

  it("keeps resuming on reconnect after the last caller unmounts", async () => {
    const transport = setup();
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();
    await webcam.turnOn();

    const later = await mountSuspended(
      defineComponent({
        setup() {
          useWebcam();
          return () => null;
        },
      }),
    );
    later.unmount();
    await reconnect();

    expect(transport.webcamStart).toHaveBeenCalledTimes(2);
    await webcam.turnOff();
  });

  it("reports a failed poll with its own message and clears it on the next success", async () => {
    const transport = setup();
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();
    await webcam.turnOn();

    vi.mocked(transport.webcamStatus).mockImplementationOnce(async () => Promise.reject(null));
    await vi.advanceTimersByTimeAsync(1000);
    expect(webcam.error.value).toBe("Webcam status unavailable.");

    await vi.advanceTimersByTimeAsync(1000);
    expect(webcam.error.value).toBeNull();
    await webcam.turnOff();
  });

  it("starts once when turned on twice", async () => {
    const transport = setup();
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();
    await Promise.all([webcam.turnOn(), webcam.turnOn()]);

    expect(transport.webcamStart).toHaveBeenCalledTimes(1);
    expect(webcam.enabled.value).toBe(true);
    await webcam.turnOff();
  });

  it("keeps webcam mode on and reports the error when a reconnect start fails", async () => {
    const transport = setup();
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();
    await webcam.turnOn();

    vi.mocked(transport.webcamStart).mockImplementationOnce(async () =>
      Promise.reject("camera is busy"),
    );
    await reconnect();

    expect(webcam.error.value).toBe("camera is busy");
    expect(webcam.enabled.value).toBe(true);
    await webcam.turnOff();
  });
  it("holds the camera queue as soon as it turns on", async () => {
    const start = deferred<WebcamStatus>();
    setup({ webcamStart: vi.fn(() => start.promise) });
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();

    const turningOn = webcam.turnOn();
    expect(isCameraQueueHeld()).toBe(true);
    start.resolve(STREAMING);
    await turningOn;
    expect(isCameraQueueHeld()).toBe(true);
    await webcam.turnOff();
  });

  it("keeps the hold when a stale start fails after a newer turn-on", async () => {
    const first = deferred<WebcamStatus>();
    const transport = setup();
    vi.mocked(transport.webcamStart).mockImplementationOnce(() => first.promise);
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();

    const turningOn = webcam.turnOn();
    await webcam.turnOff();
    await webcam.turnOn();
    first.reject(new Error("late failure"));
    await turningOn;

    expect(webcam.enabled.value).toBe(true);
    expect(webcam.error.value).toBeNull();
    expect(isCameraQueueHeld()).toBe(true);
    await webcam.turnOff();
  });

  it("keeps the hold when turned back on while a turn-off is stopping", async () => {
    const stop = deferred<void>();
    const transport = setup();
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();
    await webcam.turnOn();

    vi.mocked(transport.webcamStop).mockImplementationOnce(() => stop.promise);
    const turningOff = webcam.turnOff();
    await webcam.turnOn();
    stop.resolve();
    await turningOff;

    expect(webcam.enabled.value).toBe(true);
    expect(isCameraQueueHeld()).toBe(true);
    await webcam.turnOff();
    expect(isCameraQueueHeld()).toBe(false);
  });

  it("skips a poll tick while the previous poll is still in flight", async () => {
    const slow = deferred<WebcamStatus>();
    const transport = setup();
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();
    await webcam.turnOn();

    vi.mocked(transport.webcamStatus).mockImplementationOnce(() => slow.promise);
    await vi.advanceTimersByTimeAsync(3000);
    expect(transport.webcamStatus).toHaveBeenCalledTimes(1);

    slow.resolve(STREAMING);
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.webcamStatus).toHaveBeenCalledTimes(2);
    await webcam.turnOff();
  });
  it("turns off when the user disconnects", async () => {
    const transport = setup();
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();
    await webcam.turnOn();

    await camera.disconnect();
    await vi.advanceTimersByTimeAsync(0);

    expect(webcam.enabled.value).toBe(false);
    expect(transport.webcamStop).toHaveBeenCalled();
    expect(isCameraQueueHeld()).toBe(false);
  });

  it("turns off when the app gives up on the camera", async () => {
    const transport = setup();
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();
    await webcam.turnOn();

    useState<boolean>("camera-want-connection").value = false;
    useState<string>("camera-status").value = "disconnected";
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);

    expect(webcam.enabled.value).toBe(false);
    expect(transport.webcamStop).toHaveBeenCalled();
    expect(isCameraQueueHeld()).toBe(false);
  });

  it("stays on through a transient drop that the app is still reconnecting", async () => {
    setup();
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();
    await webcam.turnOn();

    useState<string>("camera-status").value = "disconnected";
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);

    expect(webcam.enabled.value).toBe(true);
    expect(isCameraQueueHeld()).toBe(true);
    await webcam.turnOff();
  });

  it("adopts a stream that Rust is already running on first use", async () => {
    const transport = setup();
    useState<boolean>("webcam-seeded").value = false;
    const webcam = await mountComposable(() => useWebcam());
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.webcamStatus).toHaveBeenCalledTimes(1);
    expect(transport.webcamStart).not.toHaveBeenCalled();
    expect(webcam.enabled.value).toBe(true);
    expect(webcam.status.value).toEqual(STREAMING);
    expect(isCameraQueueHeld()).toBe(true);
    await webcam.turnOff();
  });

  it("stays off on first use when Rust is not running, and seeds only once", async () => {
    const transport = setup({
      webcamStatus: vi.fn(async () => ({ ...STREAMING, state: "off" as const })),
    });
    useState<boolean>("webcam-seeded").value = false;
    const webcam = await mountComposable(() => useWebcam());
    await vi.advanceTimersByTimeAsync(0);
    await mountComposable(() => useWebcam());
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.webcamStatus).toHaveBeenCalledTimes(1);
    expect(webcam.enabled.value).toBe(false);
    expect(isCameraQueueHeld()).toBe(false);
  });
  it("stops the stream before the session is torn down on a user disconnect", async () => {
    const order: string[] = [];
    setup({
      webcamStop: vi.fn(async () => {
        order.push("webcamStop");
      }),
      disconnect: vi.fn(async () => {
        order.push("disconnect");
      }),
    });
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();
    await webcam.turnOn();
    order.length = 0;

    await camera.disconnect();

    expect(order).toEqual(["webcamStop", "disconnect"]);
  });

  it("stops the stream before the session is torn down on a forced disconnect", async () => {
    const order: string[] = [];
    setup({
      probe: vi.fn(async () => false),
      webcamStop: vi.fn(async () => {
        order.push("webcamStop");
      }),
      disconnect: vi.fn(async () => {
        order.push("disconnect");
      }),
    });
    const { camera, webcam } = await mountComposable(() => ({
      camera: useCamera(),
      webcam: useWebcam(),
    }));
    await camera.connect();
    await webcam.turnOn();
    order.length = 0;

    for (let i = 0; i < FAILURE_THRESHOLD; i++) reportCameraFailure();
    await vi.advanceTimersByTimeAsync(0);

    expect(order).toEqual(["webcamStop", "disconnect"]);
  });

  it("keeps polling an adopted stream while the camera shows disconnected", async () => {
    const transport = setup();
    useState<boolean>("webcam-seeded").value = false;
    const webcam = await mountComposable(() => useWebcam());
    await vi.advanceTimersByTimeAsync(0);
    expect(webcam.enabled.value).toBe(true);
    vi.mocked(transport.webcamStatus).mockClear();
    vi.mocked(transport.webcamStatus).mockImplementation(async () => STALLED);

    await vi.advanceTimersByTimeAsync(1000);

    expect(transport.webcamStatus).toHaveBeenCalledTimes(1);
    expect(webcam.status.value).toEqual(STALLED);
    await webcam.turnOff();
  });

  it("retries the seed on the next use when the first call fails", async () => {
    const transport = setup();
    vi.mocked(transport.webcamStatus).mockImplementationOnce(async () =>
      Promise.reject(new Error("not ready")),
    );
    useState<boolean>("webcam-seeded").value = false;
    const first = await mountComposable(() => useWebcam());
    await vi.advanceTimersByTimeAsync(0);
    expect(first.enabled.value).toBe(false);

    const second = await mountComposable(() => useWebcam());
    await vi.advanceTimersByTimeAsync(0);

    expect(second.enabled.value).toBe(true);
    await second.turnOff();
  });
});
