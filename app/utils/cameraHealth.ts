/**
 * Watches for the camera going silent mid-session. Only transport failures
 * count: a thrown fetch (timeout, refused connection, Wi-Fi gone). Any
 * completed HTTP response, including a 404 for a missing file, proves the
 * camera is answering and resets the count, so one bad file can never end a
 * working session.
 *
 * Reaching the threshold is not proof on its own: a single large download that
 * retries and drops three times can get there while the camera is perfectly
 * healthy. So the threshold only triggers a cheap probe request, and the
 * session is dropped only when that probe also fails.
 *
 * The probe is injected rather than imported so this module stays pure: no
 * Vue, no Nuxt, no fetch, unit-testable under a plain node environment.
 */
export const FAILURE_THRESHOLD = 3;

let consecutiveFailures = 0;
let onDeadCallback: (() => void) | null = null;
let probeCamera: (() => Promise<boolean>) | null = null;
let probeInFlight = false;
let transferDepth = 0;

export function beginHealthTransfer(): void {
  transferDepth += 1;
  consecutiveFailures = 0;
}

export function endHealthTransfer(): void {
  transferDepth = Math.max(0, transferDepth - 1);
}
/**
 * Start counting. Replaces any previous callback and resets the count.
 *
 * @param onDead Called once when the camera is confirmed gone.
 * @param probe Cheap liveness check; resolves true when the camera answered.
 */
export function armCameraHealth(onDead: () => void, probe: () => Promise<boolean>): void {
  consecutiveFailures = 0;
  probeInFlight = false;
  onDeadCallback = onDead;
  probeCamera = probe;
}

/** Stop counting. Reports become no-ops until armed again. */
export function disarmCameraHealth(): void {
  consecutiveFailures = 0;
  probeInFlight = false;
  onDeadCallback = null;
  probeCamera = null;
}

export function reportCameraSuccess(): void {
  if (!onDeadCallback) return;
  consecutiveFailures = 0;
}

export function reportCameraFailure(): void {
  // While a probe is open the verdict is already being decided; further
  // failures must not open a second one.
  if (!onDeadCallback || probeInFlight || transferDepth > 0) return;
  consecutiveFailures += 1;
  if (consecutiveFailures < FAILURE_THRESHOLD) return;
  void runProbe();
}

async function runProbe(): Promise<void> {
  const probe = probeCamera;
  const callback = onDeadCallback;
  if (!probe || !callback) return;

  probeInFlight = true;
  let alive = false;
  try {
    alive = await probe();
  } catch {
    alive = false;
  }

  // The session may have been torn down or re-armed while the probe was open;
  // in that case this verdict is stale and must not fire anything.
  if (onDeadCallback !== callback) return;
  probeInFlight = false;

  if (alive) {
    // The camera answered, so the failures were the transfer's fault.
    consecutiveFailures = 0;
    return;
  }

  // Disarm before invoking so nothing can fire the callback a second time.
  disarmCameraHealth();
  callback();
}
