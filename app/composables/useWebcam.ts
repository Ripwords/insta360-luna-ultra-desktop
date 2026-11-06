import { effectScope } from "vue";
import type { WebcamStatus } from "~/types/media";
import { setCameraQueueHeld } from "~/utils/cameraQueue";
import { errorMessage } from "~/utils/errorMessage";
import { getCameraTransport } from "~/utils/transport";

const POLL_INTERVAL_MS = 1000;
const START_FALLBACK = "Webcam mode could not start.";
const POLL_FALLBACK = "Webcam status unavailable.";

const STOPPED: WebcamStatus = {
  state: "stopped",
  url: null,
  codec: null,
  width: null,
  height: null,
  clients: 0,
  secondsSinceFrame: null,
};

let pollTimer: ReturnType<typeof setInterval> | undefined;
/**
 * Bumped by every turn-on and turn-off. A start or poll that was in flight
 * across a bump answers a question nobody is asking any more, so its result
 * is dropped instead of overwriting the current state.
 */
let generation = 0;
let reconnectWatchStarted = false;
/** Generation of the poll in flight, so a slow camera never gets stacked calls. */
let pollInFlight: number | null = null;

function stopPolling() {
  if (pollTimer !== undefined) clearInterval(pollTimer);
  pollTimer = undefined;
}

export function useWebcam() {
  const { isConnected } = useCamera();
  const { active: activeDownloads, resume: resumeDownloads } = useDownloads();

  const enabled = useState<boolean>("webcam-enabled", () => false);
  const status = useState<WebcamStatus | null>("webcam-status", () => null);
  const error = useState<string | null>("webcam-error", () => null);

  // Set on the first call so a webview reload does not forget a stream that
  // Rust is still serving. Shared state, so the answer is asked for only once.
  const seeded = useState<boolean>("webcam-seeded", () => false);

  const blockedByDownloads = computed(() => activeDownloads.value.length > 0);

  async function poll() {
    if (!enabled.value || !isConnected.value) return;
    const started = generation;
    if (pollInFlight === started) return;
    pollInFlight = started;
    try {
      const next = await getCameraTransport().webcamStatus();
      // A turn-off or disconnect may have landed while the call was in flight.
      if (started !== generation || !enabled.value || !isConnected.value) return;
      status.value = next;
      error.value = null;
    } catch (cause) {
      if (started === generation) error.value = errorMessage(cause, POLL_FALLBACK);
    } finally {
      if (pollInFlight === started) pollInFlight = null;
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  }

  /**
   * Ask the camera to start streaming. Resolves false when the answer arrived
   * after a turn-off or a newer turn-on, in which case nothing is written.
   */
  async function begin(): Promise<boolean> {
    const started = generation;
    const next = await getCameraTransport().webcamStart();
    if (started !== generation) {
      // Turned off mid-start: the camera is now streaming for nobody. If it
      // was turned back on instead, the newer start owns the stream.
      if (!enabled.value)
        await getCameraTransport()
          .webcamStop()
          .catch(() => {});
      return false;
    }
    status.value = next;
    return true;
  }

  async function seed() {
    if (seeded.value || !getCameraTransport().available) return;
    seeded.value = true;
    const started = generation;
    try {
      const current = await getCameraTransport().webcamStatus();
      // Anything the user did while this was in flight is newer than the answer.
      if (started !== generation || enabled.value || current.state === "off") return;
      enabled.value = true;
      status.value = current;
      setCameraQueueHeld(true);
      startPolling();
    } catch {
      // Nothing to adopt; the next explicit turn-on reports real errors.
    }
  }
  if (import.meta.client) void seed();

  async function turnOn() {
    if (enabled.value) return;
    if (blockedByDownloads.value) {
      error.value = "Finish or cancel your downloads first.";
      return;
    }
    const started = ++generation;
    error.value = null;
    enabled.value = true;
    // Held before the start call, so no file transfer can begin while the
    // camera is switching to streaming.
    setCameraQueueHeld(true);
    try {
      if (!(await begin())) return;
      startPolling();
    } catch (cause) {
      // A stale failure leaves the hold to whichever turn-on or turn-off
      // superseded it.
      if (started !== generation) return;
      enabled.value = false;
      setCameraQueueHeld(false);
      resumeDownloads();
      error.value = errorMessage(cause, START_FALLBACK);
    }
  }

  async function turnOff() {
    const stopping = ++generation;
    stopPolling();
    enabled.value = false;
    status.value = null;
    error.value = null;
    await getCameraTransport()
      .webcamStop()
      .catch((cause) => {
        error.value = errorMessage(cause, "Webcam mode could not stop.");
      });
    // Released only once the camera has stopped streaming, so file traffic
    // never overlaps the stream's tail. A turn-on during the stop owns the
    // hold now.
    if (stopping !== generation) return;
    setCameraQueueHeld(false);
    resumeDownloads();
  }

  // One watcher for the whole app, in a detached scope: bound to a component,
  // it would die with whichever page happened to create it, and webcam mode
  // would silently stop resuming after a reconnect.
  if (!reconnectWatchStarted) {
    reconnectWatchStarted = true;
    effectScope(true).run(() => {
      const { isConnected: connectedNow } = useCamera();
      // `wantConnection` drops only on a user disconnect or the app giving up
      // on the camera. A transient drop leaves it set while reconnecting.
      const wantConnection = useState<boolean>("camera-want-connection", () => false);
      watch(wantConnection, (wanted) => {
        if (!wanted && enabled.value) void turnOff();
      });
      watch(connectedNow, async (connected) => {
        if (!enabled.value) return;
        if (!connected) {
          status.value = STOPPED;
          return;
        }
        const started = generation;
        try {
          await begin();
        } catch (cause) {
          if (started === generation) error.value = errorMessage(cause, START_FALLBACK);
        }
      });
    });
  }

  return { enabled, status, error, blockedByDownloads, turnOn, turnOff };
}
