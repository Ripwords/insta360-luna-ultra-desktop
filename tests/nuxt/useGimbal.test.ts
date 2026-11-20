import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  GIMBAL_FAIL_MS,
  GIMBAL_MAX_IN_FLIGHT,
  GIMBAL_STOP_FRAMES,
  GIMBAL_TICK_MS,
} from "~/composables/useGimbal";
import {
  CODE_GIMBAL_CONTROL,
  encodeGimbalAction,
  encodeGimbalMove,
  GIMBAL_ACTION,
} from "~/utils/gimbal";
import { type CameraTransport, resetCameraTransport, setCameraTransport } from "~/utils/transport";
import { makeFakeTransport } from "../helpers/fakeTransport";
import { mountComposable } from "./harness";

type Command = Mock<CameraTransport["command"]>;

function setup(command: Command = vi.fn(async () => new Uint8Array(0))) {
  setCameraTransport(makeFakeTransport({ command }));
  return command;
}

/** Connected, with the viewfinder streaming: the only state the gimbal answers in. */
function streaming() {
  useState<string>("camera-status").value = "connected";
  useState<boolean>("liveview-active").value = true;
}

const bodies = (command: Command) =>
  command.mock.calls
    .filter(([code]) => code === CODE_GIMBAL_CONTROL)
    .map(([, body]) => Array.from(body as Uint8Array));

describe("useGimbal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    // Let any loop left running wind down before the next test
    await vi.advanceTimersByTimeAsync(GIMBAL_TICK_MS * (GIMBAL_STOP_FRAMES + 2));
    vi.useRealTimers();
    resetCameraTransport();
    clearNuxtState([
      "camera-status",
      "liveview-active",
      "webcam-enabled",
      "gimbal-vector",
      "gimbal-error",
    ]);
  });

  it("sends nothing until the preview is running", async () => {
    const command = setup();
    useState<string>("camera-status").value = "connected";
    const gimbal = await mountComposable(() => useGimbal());

    gimbal.steer(50, 0);
    await vi.advanceTimersByTimeAsync(GIMBAL_TICK_MS * 3);

    expect(gimbal.ready.value).toBe(false);
    expect(bodies(command)).toEqual([]);
  });

  it("resends the latest vector every tick, then stops with zero vectors", async () => {
    const command = setup();
    streaming();
    const gimbal = await mountComposable(() => useGimbal());

    gimbal.steer(60, 0);
    await vi.advanceTimersByTimeAsync(GIMBAL_TICK_MS * 2);
    gimbal.steer(30, -20);
    await vi.advanceTimersByTimeAsync(GIMBAL_TICK_MS);
    gimbal.release();
    await vi.advanceTimersByTimeAsync(GIMBAL_TICK_MS * (GIMBAL_STOP_FRAMES + 3));

    const move = Array.from(encodeGimbalMove(60, 0));
    const turn = Array.from(encodeGimbalMove(30, -20));
    const stop = Array.from(encodeGimbalMove(0, 0));
    const sent = bodies(command);
    expect(sent.slice(0, 3)).toEqual([move, move, move]);
    expect(sent[3]).toEqual(turn);
    expect(sent.slice(-GIMBAL_STOP_FRAMES)).toEqual(Array(GIMBAL_STOP_FRAMES).fill(stop));
    expect(sent.filter((body) => body.join() === stop.join())).toHaveLength(GIMBAL_STOP_FRAMES);
  });

  it("keeps sending past a slow reply, up to a cap, and always sends the stop", async () => {
    const replies: Array<() => void> = [];
    const command = setup(
      vi.fn<CameraTransport["command"]>(
        () =>
          new Promise<Uint8Array>((resolve) => {
            replies.push(() => resolve(new Uint8Array(0)));
          }),
      ),
    );
    streaming();
    const gimbal = await mountComposable(() => useGimbal());

    gimbal.steer(40, 0);
    await vi.advanceTimersByTimeAsync(GIMBAL_TICK_MS * 6);
    expect(bodies(command)).toHaveLength(GIMBAL_MAX_IN_FLIGHT);

    // No reply has come back, and letting go must still stop the gimbal
    gimbal.release();
    await vi.advanceTimersByTimeAsync(GIMBAL_TICK_MS * (GIMBAL_STOP_FRAMES + 2));
    const stop = Array.from(encodeGimbalMove(0, 0));
    expect(bodies(command).slice(GIMBAL_MAX_IN_FLIGHT)).toEqual(
      Array(GIMBAL_STOP_FRAMES).fill(stop),
    );
    for (const reply of replies) reply();
  });

  it("lets go when the preview stops mid-gesture", async () => {
    const command = setup();
    streaming();
    const gimbal = await mountComposable(() => useGimbal());

    gimbal.steer(70, 0);
    await vi.advanceTimersByTimeAsync(GIMBAL_TICK_MS);
    useState<boolean>("liveview-active").value = false;
    await nextTick();
    await vi.advanceTimersByTimeAsync(GIMBAL_TICK_MS * (GIMBAL_STOP_FRAMES + 3));

    expect(gimbal.vector.value).toEqual({ pan: 0, tilt: 0 });
    expect(bodies(command).at(-1)).toEqual(Array.from(encodeGimbalMove(0, 0)));
  });

  it("recenters and flips with one-shot actions", async () => {
    const command = setup();
    streaming();
    const gimbal = await mountComposable(() => useGimbal());

    await gimbal.recenter();
    await gimbal.flip();

    const sent = bodies(command);
    expect(sent).toContainEqual(Array.from(encodeGimbalAction(GIMBAL_ACTION.RECENTER)));
    expect(sent).toContainEqual(Array.from(encodeGimbalAction(GIMBAL_ACTION.FLIP)));
  });

  it("shrugs off a lost reply, and reports a second without any", async () => {
    setup(vi.fn<CameraTransport["command"]>(async () => Promise.reject("camera is not connected")));
    streaming();
    const gimbal = await mountComposable(() => useGimbal());

    gimbal.steer(50, 0);
    await vi.advanceTimersByTimeAsync(GIMBAL_TICK_MS * 3);
    expect(gimbal.error.value).toBeNull();

    await vi.advanceTimersByTimeAsync(GIMBAL_FAIL_MS);
    expect(gimbal.error.value).toBe("camera is not connected");
  });
});
