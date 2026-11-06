import type { WebcamStatus } from "~/types/media";
import { setCameraQueueHeld } from "~/utils/cameraQueue";
import { errorMessage } from "~/utils/errorMessage";
import { getCameraTransport } from "~/utils/transport";

const POLL_INTERVAL_MS = 1000;
const START_FALLBACK = "Webcam mode could not start.";

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
let stopReconnectWatch: (() => void) | undefined;

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

  const blockedByDownloads = computed(() => activeDownloads.value.length > 0);

  async function poll() {
    if (!enabled.value || !isConnected.value) return;
    try {
      const next = await getCameraTransport().webcamStatus();
      // A turn-off or disconnect may have landed while the call was in flight.
      if (enabled.value && isConnected.value) status.value = next;
    } catch (cause) {
      error.value = errorMessage(cause, START_FALLBACK);
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  }

  async function begin() {
    status.value = await getCameraTransport().webcamStart();
  }

  async function turnOn() {
    if (enabled.value) return;
    if (blockedByDownloads.value) {
      error.value = "Finish or cancel your downloads first.";
      return;
    }
    error.value = null;
    enabled.value = true;
    try {
      await begin();
      setCameraQueueHeld(true);
      startPolling();
    } catch (cause) {
      enabled.value = false;
      setCameraQueueHeld(false);
      error.value = errorMessage(cause, START_FALLBACK);
    }
  }

  async function turnOff() {
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
    // never overlaps the stream's tail.
    setCameraQueueHeld(false);
    resumeDownloads();
  }

  // Every component that calls useWebcam() would otherwise add its own
  // watcher, and each would call webcamStart on reconnect. Keep exactly one.
  stopReconnectWatch?.();
  stopReconnectWatch = watch(isConnected, async (connected) => {
    if (!enabled.value) return;
    if (!connected) {
      status.value = STOPPED;
      return;
    }
    try {
      await begin();
    } catch (cause) {
      error.value = errorMessage(cause, START_FALLBACK);
    }
  });

  return { enabled, status, error, blockedByDownloads, turnOn, turnOff };
}
