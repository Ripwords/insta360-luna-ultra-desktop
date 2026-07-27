import type { MockState } from "./mockClient";
import { FIXTURE_PATHS } from "./fixtures";

/**
 * Named seed states, so a prose passage can open the demo already in the
 * situation it is describing.
 */
export const PRESETS: Record<string, Partial<MockState>> = {
  default: { connected: true },
  empty: { connected: true, paths: [] },
  selection: { connected: true, paths: FIXTURE_PATHS.slice(0, 6) },
  disconnected: { connected: false, paths: [] },
};

export function presetOrDefault(name?: string): Partial<MockState> {
  if (!name) return PRESETS.default!;
  const preset = PRESETS[name];
  if (!preset && import.meta.dev) console.warn(`[demo] unknown preset "${name}"`);
  return preset ?? PRESETS.default!;
}
