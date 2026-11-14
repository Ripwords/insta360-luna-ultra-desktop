import { errorMessage } from "~/utils/errorMessage";
import { HeadFollower, headTrackingClient, type HeadPose } from "~/utils/headTracking";

/** No sample for this long while on means the headphones are not sending. */
export const HEAD_SILENCE_MS = 2000;

export type HeadTrackingState = "off" | "starting" | "waiting" | "tracking";

/**
 * Steer the gimbal with AirPods.
 *
 * Turning it on recenters the gimbal and takes the head as it is at that
 * moment as "straight ahead"; from then on the camera points where the head
 * does. Off, the gimbal is left exactly where it is.
 *
 * The follower and the listener are one per app, like the gimbal loop:
 * several components may show the toggle, and two followers would fight.
 */
let follower: HeadFollower | null = null;
let unlisten: (() => void) | null = null;
let lastSample = 0;
let silence: ReturnType<typeof setInterval> | null = null;
/** Re-zero on the next sample rather than at a pose we have not seen yet. */
let zeroPending = false;

export function useHeadTracking() {
  const gimbal = useGimbal();
  const supported = useState<boolean>("headtrack-supported", () => false);
  const state = useState<HeadTrackingState>("headtrack-state", () => "off");
  const error = useState<string | null>("headtrack-error", () => null);

  const on = computed(() => state.value !== "off");

  async function refreshSupport() {
    try {
      supported.value = (await headTrackingClient.status()).supported;
    } catch {
      supported.value = false;
    }
  }

  function onPose(pose: HeadPose) {
    if (state.value === "off" || !follower) return;
    const now = performance.now();
    const seconds = lastSample ? (now - lastSample) / 1000 : 0;
    lastSample = now;
    if (state.value !== "tracking") state.value = "tracking";
    if (zeroPending) {
      zeroPending = false;
      follower.zero(pose);
      return;
    }
    const { pan, tilt } = follower.step(pose, seconds);
    if (pan === 0 && tilt === 0) gimbal.release();
    else gimbal.steer(pan, tilt);
  }

  async function start() {
    if (on.value) return;
    error.value = null;
    if (!gimbal.ready.value) {
      error.value = "Start the preview first: the gimbal only moves while it runs.";
      return;
    }
    state.value = "starting";
    try {
      follower = new HeadFollower();
      zeroPending = true;
      lastSample = 0;
      unlisten = await headTrackingClient.onPose(onPose);
      const status = await headTrackingClient.start();
      if (status.authorization === "denied" || status.authorization === "restricted") {
        throw new Error(
          "Motion access is off. Allow Luna Ultra Desktop in System Settings › Privacy & Security › Motion & Fitness.",
        );
      }
      await gimbal.recenter();
      if (state.value === "starting") state.value = "waiting";
      silence = setInterval(() => {
        if (state.value === "off") return;
        if (performance.now() - lastSample > HEAD_SILENCE_MS) {
          state.value = "waiting";
          gimbal.release();
        }
      }, 500);
    } catch (cause) {
      error.value = errorMessage(cause, "Head tracking could not start");
      await stop();
    }
  }

  async function stop() {
    state.value = "off";
    if (silence) clearInterval(silence);
    silence = null;
    unlisten?.();
    unlisten = null;
    follower = null;
    gimbal.release();
    try {
      await headTrackingClient.stop();
    } catch {
      // Already stopped is the outcome we wanted
    }
  }

  /** Straight ahead is wherever the head points now, and the gimbal returns to centre. */
  async function recenter() {
    zeroPending = true;
    gimbal.release();
    await gimbal.recenter();
  }

  async function toggle() {
    if (on.value) await stop();
    else await start();
  }

  // Without the preview the camera ignores the gimbal, and the estimate of
  // where it points is no longer worth anything
  watch(gimbal.ready, (ready) => {
    if (!ready && on.value) void stop();
  });

  return { supported, state, on, error, refreshSupport, start, stop, toggle, recenter };
}
