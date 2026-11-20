import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { GIMBAL_STOP_FRAMES, GIMBAL_TICK_MS } from "~/composables/useGimbal";
import { HEAD_SILENCE_MS } from "~/composables/useHeadTracking";
import { CODE_GIMBAL_CONTROL, encodeGimbalAction, GIMBAL_ACTION } from "~/utils/gimbal";
import type { HeadPose } from "~/utils/headTracking";
import { type CameraTransport, resetCameraTransport, setCameraTransport } from "~/utils/transport";
import { makeFakeTransport } from "../helpers/fakeTransport";
import { mountComposable } from "./harness";

const client = vi.hoisted(() => ({
  emit: null as ((pose: HeadPose) => void) | null,
  status: { supported: true, authorization: "authorized", active: false },
}));

vi.mock("~/utils/headTracking", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/utils/headTracking")>();
  return {
    ...actual,
    headTrackingClient: {
      status: vi.fn(async () => client.status),
      start: vi.fn(async () => ({ ...client.status, active: true })),
      stop: vi.fn(async () => {}),
      onPose: vi.fn(async (handler: (pose: HeadPose) => void) => {
        client.emit = handler;
        return () => {
          client.emit = null;
        };
      }),
    },
  };
});

type Command = Mock<CameraTransport["command"]>;

function setup() {
  const command: Command = vi.fn(async () => new Uint8Array(0));
  setCameraTransport(makeFakeTransport({ command }));
  return command;
}

function streaming() {
  useState<string>("camera-status").value = "connected";
  useState<boolean>("liveview-active").value = true;
}

const pose = (yaw: number, pitch = 0): HeadPose => ({ yaw, pitch, roll: 0 });

/** Send poses at 50 Hz for `ms`, like CoreMotion does. */
async function feed(at: HeadPose, ms: number) {
  for (let t = 0; t < ms; t += 20) {
    client.emit?.(at);
    await vi.advanceTimersByTimeAsync(20);
  }
}

describe("useHeadTracking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    client.status = { supported: true, authorization: "authorized", active: false };
  });

  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(GIMBAL_TICK_MS * (GIMBAL_STOP_FRAMES + 2));
    vi.useRealTimers();
    resetCameraTransport();
    clearNuxtState([
      "camera-status",
      "liveview-active",
      "webcam-enabled",
      "gimbal-vector",
      "gimbal-error",
      "headtrack-supported",
      "headtrack-state",
      "headtrack-error",
    ]);
  });

  it("refuses to start without the preview", async () => {
    setup();
    useState<string>("camera-status").value = "connected";
    const head = await mountComposable(() => useHeadTracking());

    await head.start();

    expect(head.on.value).toBe(false);
    expect(head.error.value).toMatch(/preview/);
  });

  it("recenters the gimbal, then follows the head", async () => {
    const command = setup();
    streaming();
    const head = await mountComposable(() => useHeadTracking());
    const gimbal = await mountComposable(() => useGimbal());

    await head.start();
    expect(command).toHaveBeenCalledWith(
      CODE_GIMBAL_CONTROL,
      encodeGimbalAction(GIMBAL_ACTION.RECENTER),
    );

    await feed(pose(0), 100); // the first sample is "straight ahead"
    expect(head.state.value).toBe("tracking");
    expect(gimbal.vector.value).toEqual({ pan: 0, tilt: 0 });

    await feed(pose(-30, 10), 60); // head turns right and up
    expect(gimbal.vector.value.pan).toBeGreaterThan(0);
    expect(gimbal.vector.value.tilt).toBeGreaterThan(0);

    await head.stop();
  });

  it("lets go and waits when the headphones go quiet", async () => {
    setup();
    streaming();
    const head = await mountComposable(() => useHeadTracking());
    const gimbal = await mountComposable(() => useGimbal());

    await head.start();
    await feed(pose(0), 60);
    await feed(pose(-40), 60);
    expect(gimbal.vector.value.pan).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(HEAD_SILENCE_MS + 600);

    expect(head.state.value).toBe("waiting");
    expect(gimbal.vector.value).toEqual({ pan: 0, tilt: 0 });
    await head.stop();
  });

  it("turns itself off when the preview stops", async () => {
    setup();
    streaming();
    const head = await mountComposable(() => useHeadTracking());

    await head.start();
    await feed(pose(0), 60);
    useState<boolean>("liveview-active").value = false;
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);

    expect(head.on.value).toBe(false);
  });

  it("explains a denied Motion permission", async () => {
    setup();
    streaming();
    client.status = { supported: true, authorization: "denied", active: false };
    const head = await mountComposable(() => useHeadTracking());

    await head.start();

    expect(head.on.value).toBe(false);
    expect(head.error.value).toMatch(/Motion & Fitness/);
  });
});
