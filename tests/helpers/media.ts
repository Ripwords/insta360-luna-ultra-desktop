import type { MediaItem } from "~/types/media";

/** A complete, valid MediaItem. Override only the fields a test asserts on. */
export function makeMediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  const name = overrides.name ?? "IMG_0001.jpg";
  const cameraPath = overrides.cameraPath ?? `/DCIM/Camera01/${name}`;
  return {
    id: cameraPath,
    name,
    type: "photo",
    storage: "internal",
    ext: "jpg",
    renderable: true,
    panoramic: false,
    takenAt: Date.UTC(2026, 6, 26, 12, 0, 0),
    size: 4_200_000,
    cameraPath,
    srcUrl: `http://127.0.0.1${cameraPath}`,
    ...overrides,
  };
}
