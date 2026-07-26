import type { CameraInfo, LiveViewStats, MediaItem } from "~/types/media";
import { lunaClient } from "~/utils/lunaClient";

/**
 * Everything the UI needs from a camera. The desktop app supplies the real
 * TCP/HTTP client; the docs-site demo supplies an in-browser mock. Nothing in
 * `components/` or `composables/` may import a concrete client directly.
 */
export interface CameraTransport {
  readonly available: boolean;
  connect(host: string): Promise<CameraInfo>;
  disconnect(): Promise<void>;
  status(): Promise<CameraInfo | null>;
  listMedia(host: string): Promise<MediaItem[]>;
  deleteFiles(cameraPaths: string[]): Promise<void>;
  command(code: number, body: Uint8Array): Promise<Uint8Array>;
  liveViewStart(): Promise<{ url: string; port: number }>;
  liveViewStop(): Promise<void>;
  liveViewStats(): Promise<LiveViewStats>;
  probeOscPreview(host: string): Promise<string | null>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  probe(host: string): Promise<boolean>;
  onDisconnect(handler: () => void): Promise<() => void>;
}

/**
 * The real client is the default, so the desktop app behaves identically
 * whether or not anything ever calls `setCameraTransport`.
 */
let current: CameraTransport = lunaClient;

export function setCameraTransport(transport: CameraTransport): void {
  current = transport;
}

/** Restore the real client. Used by tests; never called by app code. */
export function resetCameraTransport(): void {
  current = lunaClient;
}

export function getCameraTransport(): CameraTransport {
  return current;
}
