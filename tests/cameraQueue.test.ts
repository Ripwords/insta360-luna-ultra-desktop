import { describe, expect, it } from "vitest";
import {
  withCameraSlot,
  CAMERA_PRIORITY,
  CAMERA_CONCURRENCY,
  setCameraQueuePaused,
} from "~/utils/cameraQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("withCameraSlot", () => {
  it("never exceeds the concurrency cap", async () => {
    let active = 0;
    let peak = 0;
    const task = () =>
      withCameraSlot(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all(Array.from({ length: 20 }, task));
    expect(peak).toBeLessThanOrEqual(CAMERA_CONCURRENCY);
    expect(peak).toBeGreaterThan(0);
  });

  it("drains higher priority work first when slots free up", async () => {
    const order: string[] = [];
    // Occupy every slot with blockers we control.
    const blockers = Array.from({ length: CAMERA_CONCURRENCY }, () => deferred<void>());
    const held = blockers.map((b) => withCameraSlot(() => b.promise));
    // Queue a low- and a high-priority task while all slots are busy.
    const low = withCameraSlot(async () => {
      order.push("low");
    }, CAMERA_PRIORITY.THUMBNAIL);
    const high = withCameraSlot(async () => {
      order.push("high");
    }, CAMERA_PRIORITY.PREVIEW);
    // Free the slots; the higher-priority queued task should run first.
    for (const b of blockers) b.resolve();
    await Promise.all([...held, low, high]);
    expect(order[0]).toBe("high");
  });

  it("propagates errors and still frees the slot", async () => {
    await expect(
      withCameraSlot(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // A subsequent task still runs (slot was released).
    await expect(withCameraSlot(async () => 42)).resolves.toBe(42);
  });

  it("re-evaluates function priorities so the pick follows the latest score", async () => {
    const order: string[] = [];
    const blockers = Array.from({ length: CAMERA_CONCURRENCY }, () => deferred<void>());
    const held = blockers.map((b) => withCameraSlot(() => b.promise));

    // Two thumbnails whose priority is a live function; "near" reports closer to
    // the viewport (higher score) only after it's queued, mimicking a scroll.
    let nearScore = -100;
    const far = withCameraSlot(
      async () => {
        order.push("far");
      },
      () => -50,
    );
    const near = withCameraSlot(
      async () => {
        order.push("near");
      },
      () => nearScore,
    );

    nearScore = -1; // "near" scrolls into view before the slots free
    for (const b of blockers) b.resolve();
    await Promise.all([...held, far, near]);
    expect(order[0]).toBe("near");
  });

  it("holds back sub-preview work while paused, and PREVIEW still runs", async () => {
    const order: string[] = [];
    setCameraQueuePaused(true);
    const thumb = withCameraSlot(async () => {
      order.push("thumb");
    }, CAMERA_PRIORITY.THUMBNAIL);
    const preview = withCameraSlot(async () => {
      order.push("preview");
    }, CAMERA_PRIORITY.PREVIEW);

    await preview; // runs despite the pause
    expect(order).toEqual(["preview"]);

    setCameraQueuePaused(false);
    await thumb; // resumes once unpaused
    expect(order).toEqual(["preview", "thumb"]);
  });
});
