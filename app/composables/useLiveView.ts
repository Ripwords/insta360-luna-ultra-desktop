import type { LiveViewStats } from "~/types/media";
import { useCameraTransport } from "~/utils/transport";

export type LiveTransport = "mjpeg" | "annexb";

/** How long to wait for any video byte before calling the attempt failed. */
const FIRST_BYTE_TIMEOUT_MS = 6000;

export function useLiveView() {
  const { host, isConnected } = useCamera();

  const active = useState<boolean>("liveview-active", () => false);
  const starting = useState<boolean>("liveview-starting", () => false);
  const transport = useState<LiveTransport | null>("liveview-transport", () => null);
  const streamUrl = useState<string | null>("liveview-url", () => null);
  const error = useState<string | null>("liveview-error", () => null);
  const diagnostics = useState<string[]>("liveview-diagnostics", () => []);

  const note = (line: string) => {
    diagnostics.value = [...diagnostics.value, line];
  };

  async function start() {
    if (starting.value || active.value) return;
    if (!isConnected.value) {
      error.value = "Connect to the camera first.";
      return;
    }
    starting.value = true;
    error.value = null;
    diagnostics.value = [];

    try {
      const osc = await useCameraTransport().probeOscPreview(host.value);
      if (osc) {
        note("OSC MJPEG preview available; using it.");
        transport.value = "mjpeg";
        streamUrl.value = osc;
        active.value = true;
        return;
      }
      note("No OSC MJPEG preview; falling back to the control-session stream.");

      const info = await useCameraTransport().liveViewStart();
      note(`Camera accepted START_LIVE_STREAM. Serving on port ${info.port}.`);
      transport.value = "annexb";
      streamUrl.value = info.url;
      active.value = true;

      // If nothing arrives, say so rather than showing an empty canvas
      setTimeout(async () => {
        if (!active.value || transport.value !== "annexb") return;
        const stats = await useCameraTransport()
          .liveViewStats()
          .catch(() => null);
        if (stats && stats.bytes === 0) {
          error.value = "The camera accepted the command but sent no video.";
          note("0 bytes received. The stream may use a frame type we do not yet recognise.");
        }
      }, FIRST_BYTE_TIMEOUT_MS);
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      note(`Failed: ${error.value}`);
      await stop();
    } finally {
      starting.value = false;
    }
  }

  async function stop() {
    active.value = false;
    transport.value = null;
    streamUrl.value = null;
    await useCameraTransport()
      .liveViewStop()
      .catch(() => {});
  }

  async function refreshStats(): Promise<LiveViewStats | null> {
    if (!active.value) return null;
    return useCameraTransport()
      .liveViewStats()
      .catch(() => null);
  }

  return {
    active,
    starting,
    transport,
    streamUrl,
    error,
    diagnostics,
    note,
    start,
    stop,
    refreshStats,
  };
}
