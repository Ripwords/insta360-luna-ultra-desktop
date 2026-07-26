import type { CameraInfo, LiveViewStats, MediaItem, MediaStorage } from "~/types/media";
import { isTauri } from "~/utils/saveFile";
import { buildMediaItems, entriesFromPaths } from "~/utils/lunaIndex";
import { reportCameraFailure, reportCameraSuccess } from "~/utils/cameraHealth";
import { concatBytes, decodeRaw, encodeTag, encodeVarint, WIRE_VARINT } from "~/utils/protobuf";

/** Storage roots the Luna Ultra exposes over HTTP, default first. */
const STORAGE_ROOTS: Array<{ path: string; id: MediaStorage }> = [
  { path: "/storage_internal/DCIM/", id: "internal" },
  { path: "/DCIM/", id: "sdcard" },
];

/**
 * GET_FILE_LIST (control-session command 13) enumerates media. Firmware 1.0.238
 * disabled the HTTP directory autoindex the app used to scrape, but individual
 * files stay fetchable by URL while the session is held.
 */
const CODE_GET_FILE_LIST = 13;
/** GetFileList.media_type: 2 = both photos and videos. */
const MEDIA_VIDEO_AND_PHOTO = 2;

/** GetFileList request body — media_type, start, limit, all varint fields. */
function fileListBody(mediaType: number, start: number, limit: number): Uint8Array {
  return concatBytes([
    [...encodeTag(1, WIRE_VARINT), ...encodeVarint(mediaType)],
    [...encodeTag(2, WIRE_VARINT), ...encodeVarint(start)],
    [...encodeTag(3, WIRE_VARINT), ...encodeVarint(limit)],
  ]);
}

interface RawDeviceInfo {
  host: string;
  deviceName?: string;
  serial?: string;
  firmware?: string;
  ssid?: string;
}

function normalizeHost(host: string): string {
  return host
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

function baseUrl(host: string, path: string): string {
  return `http://${normalizeHost(host)}${path}`;
}

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/**
 * Fetch a camera URL. Uses the Tauri HTTP plugin (bypasses CORS/mixed-content)
 * when packaged. Every camera request flows through here, so this is also
 * where the health counter is fed: a completed response of any status means
 * the camera answered, a thrown request means it did not.
 */
export async function cameraFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    const response = await rawCameraFetch(url, init);
    reportCameraSuccess();
    return response;
  } catch (error) {
    reportCameraFailure();
    throw error;
  }
}

/** The transport on its own, with no health reporting attached. */
async function rawCameraFetch(url: string, init?: RequestInit): Promise<Response> {
  if (isTauri()) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch(url, init);
  }
  return fetch(url, init);
}

/**
 * Cheap liveness check used by the health detector: ask for the storage root
 * listing and treat any completed response, whatever the status, as proof the
 * camera answered. Deliberately bypasses `cameraFetch` so the probe cannot
 * feed the very counter that triggered it.
 */
export async function probeCamera(host: string): Promise<boolean> {
  const root = STORAGE_ROOTS[0]!;
  try {
    await rawCameraFetch(baseUrl(host, root.path), { headers: { "Cache-Control": "no-cache" } });
    return true;
  } catch {
    return false;
  }
}

function toInfo(raw: RawDeviceInfo): CameraInfo {
  return {
    host: raw.host,
    deviceName: raw.deviceName,
    serial: raw.serial,
    firmware: raw.firmware,
    ssid: raw.ssid,
  };
}

export const lunaClient = {
  get available(): boolean {
    return isTauri();
  },

  /** Open the TCP control session; returns parsed device info. Tauri only. */
  async connect(host: string): Promise<CameraInfo> {
    const raw = await tauriInvoke<RawDeviceInfo>("luna_connect", { host: normalizeHost(host) });
    return toInfo(raw);
  },

  async disconnect(): Promise<void> {
    if (isTauri()) await tauriInvoke("luna_disconnect");
  },

  async status(): Promise<CameraInfo | null> {
    if (!isTauri()) return null;
    const raw = await tauriInvoke<RawDeviceInfo | null>("luna_status");
    return raw ? toInfo(raw) : null;
  },

  async deleteFiles(cameraPaths: string[]): Promise<void> {
    await tauriInvoke("luna_delete_files", { paths: cameraPaths });
  },

  /** Send a raw protobuf body; returns the raw response body. */
  async command(code: number, body: Uint8Array): Promise<Uint8Array> {
    const response = await tauriInvoke<number[]>("luna_command", {
      code,
      body: Array.from(body),
    });
    return new Uint8Array(response);
  },

  async liveViewStart(): Promise<{ url: string; port: number }> {
    return tauriInvoke<{ url: string; port: number }>("luna_liveview_start");
  },

  async liveViewStop(): Promise<void> {
    if (isTauri()) await tauriInvoke("luna_liveview_stop");
  },

  async liveViewStats(): Promise<LiveViewStats> {
    return tauriInvoke<LiveViewStats>("luna_liveview_stats");
  },

  /**
   * Some Insta360 bodies expose an OSC MJPEG preview on port 80. If this
   * camera does, it is a far simpler transport than the elementary stream,
   * so it is tried first. Returns the URL on success, null otherwise.
   */
  async probeOscPreview(host: string): Promise<string | null> {
    const url = baseUrl(host, "/osc/commands/execute");
    try {
      const response = await cameraFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json;charset=utf-8" },
        body: JSON.stringify({ name: "camera.getLivePreview" }),
      });
      if (!response.ok) return null;
      const type = response.headers.get("content-type") ?? "";
      return type.includes("multipart") || type.includes("jpeg") ? url : null;
    } catch {
      return null;
    }
  },

  /**
   * Read the full media library by walking each storage root's CameraNN
   * subdirectories. Requires a live control session (it authorizes HTTP).
   */
  async listMedia(host: string): Promise<MediaItem[]> {
    // Page through GET_FILE_LIST over the control session, collecting every
    // file path, then build items and fetch each by URL (session-authorized).
    const decoder = new TextDecoder();
    const paths: string[] = [];
    const limit = 50;
    let start = 0;
    let total = Infinity;
    while (start < total) {
      const fields = decodeRaw(
        await this.command(CODE_GET_FILE_LIST, fileListBody(MEDIA_VIDEO_AND_PHOTO, start, limit)),
      );
      const page = fields
        .filter((f) => f.field === 1 && f.value instanceof Uint8Array)
        .map((f) => decoder.decode(f.value as Uint8Array));
      const totalField = fields.find((f) => f.field === 2 && typeof f.value === "number");
      if (typeof totalField?.value === "number") total = totalField.value;
      if (page.length === 0) break;
      paths.push(...page);
      start += page.length;
    }

    const entries = entriesFromPaths(paths, (path) => baseUrl(host, path));
    const items = buildMediaItems(entries);
    items.sort((a, b) => b.takenAt - a.takenAt);
    return items;
  },
};
