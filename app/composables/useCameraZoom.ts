import { ZOOM_MIN, zoomForFraction, zoomFraction } from "~/utils/cameraLabels";

/** No more than one blind write per this while a gesture is running. */
const THROTTLE_MS = 90;

/**
 * Zoom as a gesture, shared by everything that can drive it.
 *
 * The first version put the whole interaction inside the dial, which made the
 * dial the only way to zoom. On a desktop that is the wrong primary: the mouse
 * wheel is what people reach for, and it wants to work over the picture itself
 * rather than over a strip at the edge. So the behaviour lives here and the dial
 * becomes one of its inputs rather than its owner.
 *
 * Movement is RELATIVE. Absolute positioning meant a click anywhere on the dial
 * teleported the zoom to wherever you happened to press, which is the single
 * worst thing a fine control can do — you cannot make a small adjustment without
 * first losing your place.
 */
export function useCameraZoom() {
  const { settings, nudgeZoom, setZoom, saving } = useCameraSettings();

  /** What the gesture is doing, which outranks the camera while it runs. */
  const pending = useState<number | null>("camera-zoom-pending", () => null);

  /**
   * Whether the dial should be showing itself.
   *
   * A permanent tick scale down the side of the picture is a lab instrument
   * bolted to a viewfinder — it competes with the shot for no benefit, since
   * the number only matters while you are changing it. So the scale surfaces on
   * interaction and settles back out of the way, which is what phone cameras do
   * and why nobody notices their zoom UI when they are not using it.
   */
  const active = useState<boolean>("camera-zoom-active", () => false);
  let fade: ReturnType<typeof setTimeout> | null = null;

  /** Show it now, and arrange for it to go quiet again shortly after. */
  function wake(hold = 1200) {
    active.value = true;
    if (fade) clearTimeout(fade);
    fade = setTimeout(() => (active.value = false), hold);
  }

  /** Keep it up for as long as a drag lasts, however long that is. */
  function hold() {
    active.value = true;
    if (fade) clearTimeout(fade);
    fade = null;
  }

  const zoom = computed(() => pending.value ?? Number(settings.value.zoom_scale ?? ZOOM_MIN));
  const fraction = computed(() => zoomFraction(zoom.value));
  const busy = computed(() => saving.value === "zoom_scale");

  let lastWrite = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;

  /**
   * Push the value at the camera, but no faster than it can keep up. The
   * trailing timer matters as much as the throttle: without it the last move of
   * a gesture — the one that decides where you stopped — is the one dropped.
   */
  function pushThrottled(scale: number) {
    const now = Date.now();
    if (trailing) clearTimeout(trailing);
    if (now - lastWrite >= THROTTLE_MS) {
      lastWrite = now;
      void nudgeZoom(scale);
      return;
    }
    trailing = setTimeout(
      () => {
        lastWrite = Date.now();
        void nudgeZoom(pending.value ?? scale);
      },
      THROTTLE_MS - (now - lastWrite),
    );
  }

  /** Move by a slice of the dial, positive being further in. */
  function nudgeBy(delta: number) {
    wake();
    const next = zoomForFraction(
      (pending.value === null ? fraction.value : zoomFraction(pending.value)) + delta,
    );
    if (next === pending.value) return;
    pending.value = next;
    pushThrottled(next);
  }

  /** Jump straight to a marked stop, as clicking a number should. */
  function jumpTo(scale: number) {
    wake();
    pending.value = null;
    void setZoom(scale);
  }

  /** End the gesture and commit where it settled, verified. */
  function commit() {
    wake();
    if (pending.value === null) return;
    const settled = pending.value;
    pending.value = null;
    if (trailing) clearTimeout(trailing);
    void setZoom(settled);
  }

  /**
   * A wheel notch is ~100px of deltaY on most mice, and trackpads send a stream
   * of small ones. Scaling by 900 makes a notch about a ninth of the range —
   * enough to feel responsive, small enough to land on a value you meant.
   */
  function onWheel(event: WheelEvent) {
    event.preventDefault();
    nudgeBy(-event.deltaY / 900);
    scheduleCommit();
  }

  // A wheel has no "let go", so settle once the notches stop arriving.
  let settle: ReturnType<typeof setTimeout> | null = null;
  function scheduleCommit() {
    if (settle) clearTimeout(settle);
    settle = setTimeout(() => commit(), 350);
  }

  return { zoom, fraction, busy, pending, active, wake, hold, nudgeBy, jumpTo, commit, onWheel };
}
