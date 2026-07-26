/**
 * Global concurrency limiter for camera HTTP traffic.
 *
 * The Luna's embedded HTTP server is single-connection and low-capacity. Each
 * gallery tile has its own IntersectionObserver that fires a download the moment
 * it nears the viewport, so a screen of tiles would otherwise launch ~16
 * transfers at once — saturating the camera and starving every request (photos,
 * RAW, and video thumbnails alike). The reference app (luna-ai-cut) caps all
 * camera-facing traffic at 2 concurrent transfers via a priority queue; we do
 * the same here.
 *
 * The slot is held for the WHOLE transfer — fetch AND body read — because the
 * camera connection isn't free until the body has been consumed. Callers pass a
 * function that does both. A task's priority may be a fixed number or a function
 * re-evaluated every time the queue picks the next task, so a grid thumbnail can
 * report how close it is to the viewport *now* — that's what makes loading
 * follow the scroll instead of the order tiles happened to mount.
 */
export const CAMERA_PRIORITY = { THUMBNAIL: 0, LISTING: 1, PREVIEW: 2 } as const;

/**
 * Max concurrent camera transfers. The reference app uses 2; on-device testing
 * showed 2 loads the grid noticeably slowly while the Luna copes with more, so
 * we run 4. If media starts failing en masse again, lower this first.
 */
export const CAMERA_CONCURRENCY = 4;

/** A fixed priority, or one re-evaluated each time the queue picks a task. */
export type CameraPriority = number | (() => number);

interface QueuedTask {
  priority: CameraPriority;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

let active = 0;
let paused = false;
const queue: QueuedTask[] = [];

const scoreOf = (priority: CameraPriority): number =>
  typeof priority === "function" ? priority() : priority;

/**
 * While a full-screen preview is open, hold back background grid thumbnails so
 * the camera's single connection serves the opened photo/video first. Loads at
 * PREVIEW priority (the opened item, and prev/next) still run.
 */
export function setCameraQueuePaused(value: boolean): void {
  paused = value;
  if (!value) drain();
}

function drain(): void {
  while (active < CAMERA_CONCURRENCY && queue.length > 0) {
    // Pick the highest-priority runnable task, re-scoring dynamic priorities so
    // the pick reflects the current scroll position.
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < queue.length; i++) {
      const score = scoreOf(queue[i]!.priority);
      if (paused && score < CAMERA_PRIORITY.PREVIEW) continue;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best === -1) break; // everything runnable is held back by the pause

    const task = queue.splice(best, 1)[0]!;
    active++;
    task
      .run()
      .then(task.resolve, task.reject)
      .finally(() => {
        active--;
        drain();
      });
  }
}

/**
 * Run `fn` while holding one of the limited camera slots. `fn` must perform the
 * entire transfer (fetch + body read) so the slot covers the whole download.
 */
export function withCameraSlot<T>(
  fn: () => Promise<T>,
  priority: CameraPriority = CAMERA_PRIORITY.THUMBNAIL,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({
      priority,
      run: fn as () => Promise<unknown>,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    drain();
  });
}

/**
 * Priority for a grid thumbnail from how close it sits to the viewport centre
 * right now: 0 at the centre, sliding negative with distance, so the closest
 * un-loaded tile is always picked next. Stays below LISTING/PREVIEW, and below
 * off-screen tiles the moment they scroll away.
 */
export function viewportPriority(el: HTMLElement | null): number {
  if (!el || typeof window === "undefined") return CAMERA_PRIORITY.THUMBNAIL;
  const rect = el.getBoundingClientRect();
  const tileCenter = rect.top + rect.height / 2;
  return -Math.abs(tileCenter - window.innerHeight / 2) / 10000;
}
