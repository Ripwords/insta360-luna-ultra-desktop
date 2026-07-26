import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAILURE_THRESHOLD,
  armCameraHealth,
  disarmCameraHealth,
  reportCameraFailure,
  reportCameraSuccess,
} from "~/utils/cameraHealth";

/** Let the in-flight probe promise chain settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A probe that reports the camera as gone, so failures reach `onDead`. */
const deadProbe = () => Promise.resolve(false);

describe("cameraHealth", () => {
  beforeEach(() => {
    disarmCameraHealth();
  });

  it("fires once after three consecutive failures", async () => {
    const onDead = vi.fn();
    armCameraHealth(onDead, deadProbe);
    for (let i = 0; i < FAILURE_THRESHOLD; i++) reportCameraFailure();
    await flush();
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("does not fire before the threshold", async () => {
    const onDead = vi.fn();
    armCameraHealth(onDead, deadProbe);
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) reportCameraFailure();
    await flush();
    expect(onDead).not.toHaveBeenCalled();
  });

  it("resets the count on any success", async () => {
    const onDead = vi.fn();
    armCameraHealth(onDead, deadProbe);
    reportCameraFailure();
    reportCameraSuccess();
    reportCameraFailure();
    reportCameraFailure();
    await flush();
    expect(onDead).not.toHaveBeenCalled();
  });

  it("ignores failures while disarmed", async () => {
    const onDead = vi.fn();
    for (let i = 0; i < FAILURE_THRESHOLD; i++) reportCameraFailure();
    armCameraHealth(onDead, deadProbe);
    reportCameraFailure();
    await flush();
    expect(onDead).not.toHaveBeenCalled();
  });

  it("does not fire again after it has fired", async () => {
    const onDead = vi.fn();
    armCameraHealth(onDead, deadProbe);
    for (let i = 0; i < FAILURE_THRESHOLD + 3; i++) reportCameraFailure();
    await flush();
    for (let i = 0; i < FAILURE_THRESHOLD + 3; i++) reportCameraFailure();
    await flush();
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("replaces the callback when armed twice", async () => {
    const first = vi.fn();
    const second = vi.fn();
    armCameraHealth(first, deadProbe);
    reportCameraFailure();
    armCameraHealth(second, deadProbe);
    for (let i = 0; i < FAILURE_THRESHOLD; i++) reportCameraFailure();
    await flush();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not disconnect when the probe says the camera is alive", async () => {
    const onDead = vi.fn();
    const probe = vi.fn(() => Promise.resolve(true));
    armCameraHealth(onDead, probe);
    for (let i = 0; i < FAILURE_THRESHOLD; i++) reportCameraFailure();
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(onDead).not.toHaveBeenCalled();
  });

  it("resets the count after a successful probe", async () => {
    const onDead = vi.fn();
    const probe = vi.fn(() => Promise.resolve(true));
    armCameraHealth(onDead, probe);
    for (let i = 0; i < FAILURE_THRESHOLD; i++) reportCameraFailure();
    await flush();
    // The counter is back at zero, so it takes a whole fresh run to probe again.
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) reportCameraFailure();
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(onDead).not.toHaveBeenCalled();
  });

  it("fires exactly once when the probe also fails", async () => {
    const onDead = vi.fn();
    const probe = vi.fn(() => Promise.resolve(false));
    armCameraHealth(onDead, probe);
    for (let i = 0; i < FAILURE_THRESHOLD; i++) reportCameraFailure();
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("treats a throwing probe as a dead camera", async () => {
    const onDead = vi.fn();
    armCameraHealth(onDead, () => Promise.reject(new Error("no route to host")));
    for (let i = 0; i < FAILURE_THRESHOLD; i++) reportCameraFailure();
    await flush();
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("does not start a second probe while one is in flight", async () => {
    const onDead = vi.fn();
    let release: (alive: boolean) => void = () => {};
    const probe = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    armCameraHealth(onDead, probe);
    for (let i = 0; i < FAILURE_THRESHOLD; i++) reportCameraFailure();
    expect(probe).toHaveBeenCalledTimes(1);

    // A burst of further failures arrives while the probe is still open.
    for (let i = 0; i < FAILURE_THRESHOLD * 2; i++) reportCameraFailure();
    expect(probe).toHaveBeenCalledTimes(1);

    release(true);
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(onDead).not.toHaveBeenCalled();
  });

  it("does not fire when disarmed while the probe is in flight", async () => {
    const onDead = vi.fn();
    let release: (alive: boolean) => void = () => {};
    const probe = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    armCameraHealth(onDead, probe);
    for (let i = 0; i < FAILURE_THRESHOLD; i++) reportCameraFailure();
    disarmCameraHealth();
    release(false);
    await flush();
    expect(onDead).not.toHaveBeenCalled();
  });
});
