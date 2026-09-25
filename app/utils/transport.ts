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
  /**
   * Implementations own health reporting for their own transport: nothing
   * outside a `fetch` implementation calls `reportCameraSuccess` or
   * `reportCameraFailure` on its behalf, so a mock that implements `fetch`
   * without reporting leaves the health watchdog armed but permanently deaf.
   */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  probe(host: string): Promise<boolean>;
  onDisconnect(handler: () => void): Promise<() => void>;
  /**
   * Bracket a large HTTP transfer (a full-resolution photo or video
   * download) so the control-channel keepalive can tolerate a slower reply
   * for as long as it runs, instead of mistaking a busy camera for a dead
   * one. Optional: implementations without a control-channel keepalive (the
   * docs-site mock) have nothing to widen and may omit both.
   */
  beginTransfer?(): Promise<void>;
  endTransfer?(): Promise<void>;
}

/**
 * The real client is the default, so the desktop app behaves identically
 * whether or not anything ever calls `setCameraTransport`.
 *
 * This is process-global, not request-scoped: under SSR every concurrent
 * request reads and writes the same `current`. A consuming app that runs
 * `ssr: true` (unlike this desktop app, which is `ssr: false`) must install
 * its transport from a client-only plugin, never from server-side code —
 * otherwise one request's transport leaks into another's. Note that the
 * composables reading this store their own data in `useState`, which IS
 * request-scoped, so the two layers do not share the same lifetime.
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
