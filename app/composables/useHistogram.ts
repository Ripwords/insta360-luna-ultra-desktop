import {
  cycleHistogramMode,
  emptyHistogram,
  HISTOGRAM_MODES,
  type Histogram,
  type HistogramMode,
} from "~/utils/histogram";

const STORAGE_KEY = "luna-histogram-mode-v1";

/**
 * Which viewfinder overlay is showing, and the latest binned frame behind it.
 *
 * The composable deliberately knows nothing about WebCodecs: `LiveView` owns
 * the `VideoFrame` and pushes results in through `publish`, because a frame is
 * only readable between decode and `close()`.
 */
export function useHistogram() {
  const state = useState<HistogramMode>("histogram-mode", () => {
    if (import.meta.client) {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && (HISTOGRAM_MODES as readonly string[]).includes(stored)) {
        return stored as HistogramMode;
      }
    }
    return "off";
  });

  const histogram = useState<Histogram>("histogram-data", () => emptyHistogram());

  // Written in `cycle` rather than through a `watch`. The mode only ever
  // changes there, so a watcher would be indirection for nothing — and it
  // would be a *per-call-site* effect on shared state, which is how you end up
  // with one component's teardown writing over another's.
  const mode = computed(() => state.value);

  const { transport } = useLiveView();

  /**
   * Only the Annex-B path can be measured. The MJPEG fallback is an `<img>`
   * pointed at the camera's own host, so reading it back taints the canvas.
   * The overlay hides itself rather than showing an empty box.
   */
  const available = computed(() => transport.value === "annexb");

  /** True when there is a reason to spend pixel reads on the next frame. */
  const sampling = computed(() => available.value && mode.value !== "off");

  function publish(next: Histogram) {
    histogram.value = next;
  }

  function cycle() {
    const next = cycleHistogramMode(state.value);
    state.value = next;
    if (import.meta.client) localStorage.setItem(STORAGE_KEY, next);
    // Drop the last reading on the way out, so re-opening the overlay cannot
    // flash a curve from a scene the camera is no longer pointed at.
    if (next === "off") histogram.value = emptyHistogram();
  }

  return { mode, histogram, available, sampling, publish, cycle };
}
