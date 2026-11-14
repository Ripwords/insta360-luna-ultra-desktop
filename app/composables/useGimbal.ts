import { errorMessage } from "~/utils/errorMessage";
import { GIMBAL_ACTION, sendGimbalAction, sendGimbalMove } from "~/utils/gimbal";

/**
 * The official app resends the joystick vector every 25–45 ms while a finger
 * is down; the camera treats it as a speed, not a target, and a vector that
 * stops arriving is not a stop. Matching that cadence is what makes the gimbal
 * glide instead of stutter.
 */
export const GIMBAL_TICK_MS = 40;

/** Zero vectors sent after a release, as the official app does, so one lost frame cannot leave it turning. */
export const GIMBAL_STOP_FRAMES = 4;

/**
 * The loop is one per app, not one per caller: the pad and the arrow keys
 * each call useGimbal(), and two loops would double the traffic.
 */
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let stopFrames = 0;

export interface GimbalVector {
  pan: number;
  tilt: number;
}

/**
 * Gimbal control, shared by every input that drives it (the on-screen pad,
 * the arrow keys, and anything that follows).
 *
 * Inputs only ever set the vector they want. A single loop owns the wire: it
 * sends the latest vector on each tick, never queues a stale one behind a slow
 * reply (one request in flight at a time), and finishes with a few zero
 * vectors once everyone has let go.
 *
 * The camera only acts on these while it is streaming its preview, so
 * `ready` follows the viewfinder and webcam mode rather than the connection.
 */
export function useGimbal() {
  const { isConnected } = useCamera();
  const { active: previewActive } = useLiveView();
  const { enabled: webcamOn } = useWebcam();

  const vector = useState<GimbalVector>("gimbal-vector", () => ({ pan: 0, tilt: 0 }));
  const error = useState<string | null>("gimbal-error", () => null);
  const ready = computed(() => isConnected.value && (previewActive.value || webcamOn.value));

  function report(cause: unknown) {
    // One message per gesture is enough; a failing link would otherwise
    // replace it 25 times a second.
    if (!error.value) error.value = errorMessage(cause, "The gimbal did not respond");
  }

  async function tick() {
    if (inFlight) return;
    const { pan, tilt } = vector.value;
    const moving = pan !== 0 || tilt !== 0;
    if (!moving) {
      if (stopFrames <= 0) {
        if (timer) clearInterval(timer);
        timer = null;
        return;
      }
      stopFrames--;
    } else {
      stopFrames = GIMBAL_STOP_FRAMES;
    }
    inFlight = true;
    try {
      await sendGimbalMove(pan, tilt);
    } catch (cause) {
      report(cause);
    } finally {
      inFlight = false;
    }
  }

  /** Ask for a speed on each axis, -100..100. Zero on both lets go. */
  function steer(pan: number, tilt: number) {
    if (!ready.value) return;
    vector.value = { pan, tilt };
    if (pan !== 0 || tilt !== 0) error.value = null;
    if (!timer) {
      stopFrames = GIMBAL_STOP_FRAMES;
      void tick();
      timer = setInterval(() => void tick(), GIMBAL_TICK_MS);
    }
  }

  function release() {
    vector.value = { pan: 0, tilt: 0 };
  }

  async function act(action: number) {
    if (!ready.value) return;
    release();
    error.value = null;
    try {
      await sendGimbalAction(action);
    } catch (cause) {
      report(cause);
    }
  }

  // Losing the preview mid-gesture must not leave a vector waiting to resume
  watch(ready, (now) => {
    if (!now) release();
  });

  return {
    vector,
    ready,
    error,
    steer,
    release,
    recenter: () => act(GIMBAL_ACTION.RECENTER),
    flip: () => act(GIMBAL_ACTION.FLIP),
  };
}
