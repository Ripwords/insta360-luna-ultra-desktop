export type MediaType = "photo" | "video";

/** Which physical storage on the camera a file lives on */
export type MediaStorage = "internal" | "sdcard";

export interface MediaItem {
  /** Absolute path on camera storage; unique id */
  id: string;
  name: string;
  type: MediaType;
  storage: MediaStorage;
  /** Extension in lowercase (jpg, dng, insp, mp4 …) */
  ext: string;
  /** True when the browser can render this file directly (not raw like DNG) */
  renderable: boolean;
  /** Equirectangular panorama / 360 photo — shown in an interactive viewer */
  panoramic: boolean;
  /** Unix epoch ms of capture time (filename timestamp, else index column) */
  takenAt: number;
  /**
   * File size in bytes, parsed from the camera's index listing. 0 when the
   * listing came from GET_FILE_LIST, which reports no size; a download
   * measures the real count and writes it back here.
   */
  size: number;
  /** Pixel dimensions are unknown until the file is decoded */
  width?: number;
  height?: number;
  /** Video duration in seconds when known */
  duration?: number;
  /** Absolute path on the camera, used for TCP delete commands */
  cameraPath: string;
  srcUrl: string;
  /** Low-res LRV proxy URL for videos and live photos, when the camera provides one */
  lrvUrl?: string;
  /**
   * Renderable stand-in for non-renderable files — e.g. the sibling JPG of a
   * RAW+JPEG pair, used as the DNG's grid thumbnail.
   */
  previewUrl?: string;
}

export type CameraStatus = "disconnected" | "connecting" | "connected";

export interface CameraInfo {
  host: string;
  deviceName?: string;
  serial?: string;
  firmware?: string;
  ssid?: string;
}

/** Live view counters, so a failed attempt can explain itself. */
export interface LiveViewStats {
  bytes: number;
  frames: number;
  firstBytesHex: string;
  seconds: number;
}

export type DownloadStatus = "queued" | "downloading" | "done" | "error";

export interface DownloadEntry {
  id: string;
  item: MediaItem;
  status: DownloadStatus;
  progress: number;
  watermarked: boolean;
  savedTo?: string;
  error?: string;
  startedAt: number;
}
