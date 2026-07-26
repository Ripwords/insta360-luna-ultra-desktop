import { vi } from "vitest";
import type { CameraInfo, LiveViewStats, MediaItem } from "~/types/media";
import type { CameraTransport } from "~/utils/transport";

const INFO: CameraInfo = {
  host: "127.0.0.1",
  deviceName: "Luna Ultra",
  serial: "FAKE-0001",
  firmware: "1.0.238",
  ssid: "Luna Ultra.OSC",
};

const STATS: LiveViewStats = { bytes: 0, frames: 0, firstBytesHex: "", seconds: 0 };

/**
 * A `CameraTransport` where every method is a vi.fn() with a benign default.
 * Override only what a test cares about.
 */
export function makeFakeTransport(overrides: Partial<CameraTransport> = {}): CameraTransport {
  const base: CameraTransport = {
    available: true,
    connect: vi.fn(async () => INFO),
    disconnect: vi.fn(async () => {}),
    status: vi.fn(async () => INFO),
    listMedia: vi.fn(async (): Promise<MediaItem[]> => []),
    deleteFiles: vi.fn(async () => {}),
    command: vi.fn(async () => new Uint8Array(0)),
    liveViewStart: vi.fn(async () => ({ url: "http://127.0.0.1:9000/live", port: 9000 })),
    liveViewStop: vi.fn(async () => {}),
    liveViewStats: vi.fn(async () => STATS),
    probeOscPreview: vi.fn(async (): Promise<string | null> => null),
    fetch: vi.fn(async () => new Response(null, { status: 200 })),
    probe: vi.fn(async () => true),
    onDisconnect: vi.fn(async () => () => {}),
  };
  return { ...base, ...overrides };
}
