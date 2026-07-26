import { CAPTURE_MODES, findMode, modeForState, type CameraMode } from "~/utils/cameraModes";
import { resetsToStandard } from "~/utils/cameraCapabilities";
import { FEATURES } from "~/utils/features";
import { readCaptureStatus, startCapture, stopCapture, takePicture } from "~/utils/lunaCapture";
import { writeDeviceOptions, writePhotographyOptions } from "~/utils/lunaSettings";

/** How often to ask the camera what it is doing while a capture runs. */
const POLL_MS = 1000;

/**
 * Modes offered in the strip. Detection still uses the full CAPTURE_MODES list,
 * so a camera already in a hidden mode is recognised — we just don't offer to
 * switch into the ones that aren't verified yet.
 */
const VISIBLE_MODES = FEATURES.extraCaptureModes
  ? CAPTURE_MODES
  : CAPTURE_MODES.filter((mode) => mode.id === "video" || mode.id === "photo");

export function useCameraCapture() {
  const { isConnected } = useCamera();
  const { settings, device, mode: functionMode, load } = useCameraSettings();

  const modeId = useState<string>("camera-capture-mode", () => "video");
  const recording = useState<boolean>("camera-recording", () => false);
  const elapsed = useState<number>("camera-capture-elapsed", () => 0);
  const busy = useState<boolean>("camera-capture-busy", () => false);
  const error = useState<string | null>("camera-capture-error", () => null);

  const current = computed<CameraMode>(() => findMode(modeId.value) ?? CAPTURE_MODES[0]!);
  const isPhoto = computed(() => current.value.captureMode === undefined);

  let timer: ReturnType<typeof setInterval> | null = null;

  async function refreshStatus() {
    if (!isConnected.value) return;
    try {
      const status = await readCaptureStatus();
      recording.value = status.recording;
      elapsed.value = status.seconds;
    } catch {
      // A dropped poll is not worth surfacing; the next one will tell us
    }
  }

  /**
   * Adopt whatever mode the camera is actually in, rather than assuming.
   *
   * Crucially this also points the settings layer at that mode's option set.
   * Photography options are stored per function mode, so a stale `functionMode`
   * sends every write to the wrong mode — and because the read-back checks that
   * same wrong mode, it agrees and the UI reports a false "applied" while the
   * live camera is untouched. Setting `functionMode` triggers a settings reload
   * through its own watcher in useCameraSettings.
   */
  function syncModeFromCamera() {
    const detected = modeForState(
      device.value.video_sub_mode ? String(device.value.video_sub_mode) : undefined,
      device.value.photo_sub_mode ? String(device.value.photo_sub_mode) : undefined,
    );
    if (!detected) return;
    modeId.value = detected.id;
    functionMode.value = detected.functionMode;
  }

  async function selectMode(id: string) {
    const target = findMode(id);
    if (!target || busy.value) return;
    busy.value = true;
    error.value = null;
    try {
      await writeDeviceOptions([target.optionType], { [target.field]: target.subMode });
      modeId.value = target.id;
      // Settings are stored per function mode, so re-read them for the new one
      functionMode.value = target.functionMode;

      // Pano, PureVideo, Slow-mo and Timelapse only shoot Standard with no
      // filter, and the camera does not clear either on the way in — switching
      // from i-Log leaves color_mode where it was. Write the reset before
      // reading back, or the panel would show the one value it can offer while
      // the camera shot something else entirely.
      if (resetsToStandard(target.id)) {
        await writePhotographyOptions(target.functionMode, ["COLOR_MODE", "VIDEO_GAMMA_MODE"], {
          color_mode: "COLOR_MODE_NORMAL",
          gamma_mode: "FILTER_NONE",
        });
      }

      await load();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy.value = false;
    }
  }

  /**
   * One button for both kinds of mode: stills take a picture, video toggles a
   * recording. The camera's own status decides which way the toggle goes.
   */
  async function trigger() {
    if (busy.value || !isConnected.value) return;
    busy.value = true;
    error.value = null;
    try {
      if (isPhoto.value) {
        await takePicture();
      } else if (recording.value) {
        await stopCapture(current.value.captureMode!);
      } else {
        await startCapture(current.value.captureMode!);
      }
      await refreshStatus();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy.value = false;
    }
  }

  watch(
    () => device.value.video_sub_mode ?? device.value.photo_sub_mode,
    () => syncModeFromCamera(),
  );

  watch(
    isConnected,
    (connected) => {
      if (timer) clearInterval(timer);
      timer = null;
      if (!connected) {
        recording.value = false;
        return;
      }
      void refreshStatus();
      timer = setInterval(() => void refreshStatus(), POLL_MS);
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    if (timer) clearInterval(timer);
  });

  const elapsedLabel = computed(() => {
    const total = Math.max(0, Math.floor(elapsed.value));
    const minutes = String(Math.floor(total / 60)).padStart(2, "0");
    const seconds = String(total % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
  });

  return {
    modes: VISIBLE_MODES,
    modeId,
    current,
    isPhoto,
    recording,
    elapsed,
    elapsedLabel,
    busy,
    error,
    settings,
    selectMode,
    trigger,
    refreshStatus,
  };
}
