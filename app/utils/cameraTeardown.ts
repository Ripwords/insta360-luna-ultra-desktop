type Hook = () => Promise<void>;

let beforeTeardown: Hook | null = null;

/**
 * Registers work that must finish before the camera session is dropped, such
 * as telling the camera to stop streaming. A hook, not an import, so the
 * camera composable need not know about webcam mode.
 */
export function setBeforeCameraTeardown(hook: Hook | null): void {
  beforeTeardown = hook;
}

/** Runs the registered hook; a failure never blocks the teardown. */
export async function runBeforeCameraTeardown(): Promise<void> {
  await beforeTeardown?.().catch(() => {});
}
