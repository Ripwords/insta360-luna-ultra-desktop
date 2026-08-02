import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeHistogram } from "~/utils/histogram";
import { mountComposable } from "./harness";

const STATE_KEYS = ["histogram-mode", "histogram-data", "liveview-transport"];

const mount = () =>
  mountComposable(() => ({
    hist: useHistogram(),
    live: useLiveView(),
  }));

describe("useHistogram", () => {
  beforeEach(() => {
    // Storage first: `{ reset: true }` re-runs the state initializer as it
    // clears, and that initializer reads storage. Clearing the other way round
    // seeds each test from the previous test's persisted mode.
    localStorage.clear();
    clearNuxtState(STATE_KEYS, { reset: true });
  });

  afterEach(() => {
    clearNuxtState(STATE_KEYS, { reset: true });
  });

  it("starts off", async () => {
    const { hist } = await mount();

    expect(hist.mode.value).toBe("off");
  });

  it("cycles off to luma to rgb and back, persisting each step", async () => {
    const { hist } = await mount();

    hist.cycle();
    expect(hist.mode.value).toBe("luma");
    expect(localStorage.getItem("luna-histogram-mode-v1")).toBe("luma");

    hist.cycle();
    expect(hist.mode.value).toBe("rgb");

    hist.cycle();
    expect(hist.mode.value).toBe("off");
  });

  it("restores a persisted mode", async () => {
    // beforeEach re-runs the state initializer as it clears, so the stored
    // value has to be planted and the state dropped again before mounting for
    // the read path to be exercised at all.
    localStorage.setItem("luna-histogram-mode-v1", "rgb");
    clearNuxtState(["histogram-mode"]);
    const { hist } = await mount();

    expect(hist.mode.value).toBe("rgb");
  });

  it("ignores a persisted value that is not a mode", async () => {
    localStorage.setItem("luna-histogram-mode-v1", "sideways");
    clearNuxtState(["histogram-mode"]);
    const { hist } = await mount();

    expect(hist.mode.value).toBe("off");
  });

  /**
   * The MJPEG fallback is an <img> on the camera's own origin, so reading it
   * back would taint the canvas. Hiding beats showing an empty box.
   */
  it("is available only on the Annex-B transport", async () => {
    const { hist, live } = await mount();

    expect(hist.available.value).toBe(false);

    live.transport.value = "mjpeg";
    expect(hist.available.value).toBe(false);

    live.transport.value = "annexb";
    expect(hist.available.value).toBe(true);
  });

  it("only asks for samples when it is both available and switched on", async () => {
    const { hist, live } = await mount();
    live.transport.value = "annexb";

    expect(hist.sampling.value).toBe(false);

    hist.cycle();
    expect(hist.sampling.value).toBe(true);

    live.transport.value = "mjpeg";
    expect(hist.sampling.value).toBe(false);
  });

  it("clears the last reading when switched off, so a stale curve cannot linger", async () => {
    const { hist, live } = await mount();
    live.transport.value = "annexb";
    hist.cycle();

    hist.publish(computeHistogram(new Uint8ClampedArray([10, 20, 30, 255])));
    expect(hist.histogram.value.total).toBe(1);

    hist.cycle(); // rgb
    expect(hist.histogram.value.total).toBe(1);

    hist.cycle(); // off
    expect(hist.histogram.value.total).toBe(0);
  });
});
