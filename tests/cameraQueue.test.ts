import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  withCameraSlot,
  CAMERA_PRIORITY,
  CAMERA_CONCURRENCY,
  setCameraQueuePaused,
  viewportPriority,
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

/**
 * The queue re-scores every runnable task each time it picks one, which for a
 * grid thumbnail means reading its position. Left unguarded that is a layout
 * read per queued tile per pick, precisely while the user is scrolling. Layout
 * cannot change without a frame boundary, so the read is cached until one.
 */
describe("viewportPriority", () => {
  let frameCallbacks: FrameRequestCallback[] = [];

  /** A stand-in tile that records how often its geometry is read. */
  function fakeTile(top: number) {
    const element = {
      reads: 0,
      getBoundingClientRect() {
        this.reads++;
        return { top, height: 100 } as DOMRect;
      },
    };
    return element as unknown as HTMLElement & { reads: number };
  }

  /** Run whatever the module scheduled, standing in for the browser's frame. */
  function advanceFrame() {
    const due = frameCallbacks;
    frameCallbacks = [];
    for (const callback of due) callback(0);
  }

  beforeEach(() => {
    // Deliberately not cleared: the module only schedules one frame at a time,
    // so dropping a pending callback would leave it believing a frame is still
    // due and stop it ever expiring its cache again.
    vi.stubGlobal("window", { innerHeight: 1000 });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    // Flush anything the previous test left pending, then land on a fresh
    // generation so no cached score leaks in.
    advanceFrame();
    viewportPriority(fakeTile(0));
    advanceFrame();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("scores by distance from the viewport centre, below every fixed priority", () => {
    const centred = viewportPriority(fakeTile(450)); // centre 500 == viewport centre
    const distant = viewportPriority(fakeTile(4000));
    expect(centred).toBeCloseTo(0);
    expect(distant).toBeLessThan(centred);
    expect(centred).toBeLessThanOrEqual(CAMERA_PRIORITY.THUMBNAIL);
  });

  it("reads geometry once per element per frame, however often it is scored", () => {
    const tile = fakeTile(300);
    const scores = Array.from({ length: 50 }, () => viewportPriority(tile));
    expect(tile.reads).toBe(1);
    // Every caller still gets the real score, not a placeholder.
    expect(new Set(scores).size).toBe(1);
    expect(scores[0]).toBeCloseTo(-Math.abs(350 - 500) / 10000);
  });

  it("re-reads after a frame, so scrolling still changes the order", () => {
    const tile = fakeTile(300);
    viewportPriority(tile);
    viewportPriority(tile);
    expect(tile.reads).toBe(1);

    advanceFrame();
    viewportPriority(tile);
    expect(tile.reads).toBe(2);
  });

  it("caches per element rather than sharing one score", () => {
    const near = fakeTile(450);
    const far = fakeTile(5000);
    expect(viewportPriority(near)).toBeGreaterThan(viewportPriority(far));
    expect(near.reads).toBe(1);
    expect(far.reads).toBe(1);
  });

  it("falls back to the base thumbnail priority without an element", () => {
    expect(viewportPriority(null)).toBe(CAMERA_PRIORITY.THUMBNAIL);
  });
});
