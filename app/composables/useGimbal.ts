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
 * Moves sent without a reply yet, before the loop waits for one. The official
 * app does not wait at all, and the camera normally answers within 50 ms, so
 * this only bites when replies go missing: a lost one must not freeze the
 * loop, which would leave the gimbal turning at its last speed.
 */
export const GIMBAL_MAX_IN_FLIGHT = 3;

/** One lost reply is noise; this long with no reply at all is a fault worth showing. */
export const GIMBAL_FAIL_MS = 1000;

/**
 * The loop is one per app, not one per caller: the stick and the arrow keys
 * each call useGimbal(), and two loops would double the traffic.
 */
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = 0;
let stopFrames = 0;
let lastAnswer = 0;

export interface GimbalVector {
  pan: number;
  tilt: number;
}

/**
 * Gimbal control, shared by every input that drives it (the drag on the picture,
 * the arrow keys, and anything that follows).
 *
 * Inputs only ever set the vector they want. A single loop owns the wire: it
 * sends the latest vector on each tick without waiting for the reply to the
 * last one (up to GIMBAL_MAX_IN_FLIGHT unanswered), and finishes with a few
 * zero vectors once everyone has let go.
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

  function tick() {
    const { pan, tilt } = vector.value;
    const moving = pan !== 0 || tilt !== 0;
    if (moving) {
      // The stop below always goes out; only moves wait for room
      if (inFlight >= GIMBAL_MAX_IN_FLIGHT) return;
      stopFrames = GIMBAL_STOP_FRAMES;
    } else {
      if (stopFrames <= 0) {
        if (timer) clearInterval(timer);
        timer = null;
        return;
      }
      stopFrames--;
    }
    inFlight++;
    sendGimbalMove(pan, tilt)
      .then(
        () => {
          lastAnswer = Date.now();
        },
        (cause: unknown) => {
          if (Date.now() - lastAnswer >= GIMBAL_FAIL_MS) report(cause);
        },
      )
      .finally(() => {
        inFlight--;
      });
  }

  /** Ask for a speed on each axis, -100..100. Zero on both lets go. */
  function steer(pan: number, tilt: number) {
    if (!ready.value) return;
    vector.value = { pan, tilt };
    if (pan !== 0 || tilt !== 0) error.value = null;
    if (!timer) {
      stopFrames = GIMBAL_STOP_FRAMES;
      lastAnswer = Date.now();
      tick();
      timer = setInterval(tick, GIMBAL_TICK_MS);
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
