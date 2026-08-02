import type { MediaItem } from "~/types/media";
import { LUNA_WATERMARK_LAYOUT } from "./watermarkLayout";

export type WatermarkPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export interface WatermarkSettings {
  enabled: boolean;
  position: WatermarkPosition;
}

export interface WatermarkRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Official watermark asset (ic_watermark_luna_ultra_image.png), 1399 x 252.
 * Root-relative in the desktop app; base-prefixed wherever the app is served
 * under a subpath. Read the base URL at call time, not module-eval time, so
 * it always reflects the current runtime config.
 */
export function watermarkAssetUrl(): string {
  return `${useRuntimeConfig().app.baseURL}watermark/ic_watermark_luna_ultra_image.png`;
}
export const WATERMARK_ASSET_RATIO = 252 / 1399;

export const WATERMARK_POSITIONS: WatermarkPosition[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

export const DEFAULT_WATERMARK: WatermarkSettings = {
  enabled: true,
  position: "bottom-left",
};

/**
 * Whether the watermark can be burned into this file at all.
 *
 * The pipeline is canvas-based — `createImageBitmap`, draw, re-encode to JPEG —
 * so it only works on files the browser can decode. RAW (`.dng`) is
 * `type: "photo"` but `renderable: false`: no engine decodes a raw Bayer frame,
 * and watermarking one would mean demosaicing it into a JPEG, i.e. not
 * returning the file the user asked for. Those save unmodified instead.
 */
export function canWatermark(item: MediaItem): boolean {
  return item.type === "photo" && item.renderable;
}

/** A selection split by what watermarking can actually do to each file. */
export interface WatermarkScope {
  /** Renderable photos — the watermark is burned into these. */
  watermarkable: MediaItem[];
  /** RAW photos, saved byte-for-byte whatever the watermark setting says. */
  raw: MediaItem[];
  /** Videos, likewise untouched. */
  videos: MediaItem[];
}

/** Split `items` so the UI can say honestly which files get a watermark. */
export function watermarkScope(items: MediaItem[]): WatermarkScope {
  const scope: WatermarkScope = { watermarkable: [], raw: [], videos: [] };
  for (const item of items) {
    if (item.type === "video") scope.videos.push(item);
    else if (canWatermark(item)) scope.watermarkable.push(item);
    else scope.raw.push(item);
  }
  return scope;
}

/**
 * One honest sentence about what the watermark will do to this selection.
 *
 * Shared by the download modal and the queue toast so neither can drift into
 * promising a watermark on files that will be saved untouched.
 */
export function watermarkNote(scope: WatermarkScope): string {
  if (scope.watermarkable.length > 0) {
    return scope.raw.length > 0
      ? "Watermark will be applied to JPEG photos; RAW files are saved unmodified."
      : "Watermark will be applied to photos.";
  }
  return scope.raw.length > 0
    ? "RAW files are saved unmodified; watermarking applies to JPEG photos only."
    : "Videos transfer untouched; watermarking applies to JPEG photos only.";
}

/** Snap an image to the closest aspect ratio in the official layout table. */
export function nearestAspect(width: number, height: number): string {
  const target = Math.log(width / height);
  let best = "16:9";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const key of Object.keys(LUNA_WATERMARK_LAYOUT)) {
    const [w, h] = key.split(":").map(Number);
    const distance = Math.abs(Math.log(w! / h!) - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = key;
    }
  }
  return best;
}

/**
 * Resolve the watermark rectangle in canvas coordinates. Ratios follow the
 * official table: width/x are fractions of image width, y is the gap between
 * the watermark's bottom edge and the image's bottom edge as a fraction of
 * image height.
 */
export function watermarkRect(
  width: number,
  height: number,
  position: WatermarkPosition,
): WatermarkRect {
  const aspect = nearestAspect(width, height);
  const [widthRatio, xRatio, yRatio] = LUNA_WATERMARK_LAYOUT[aspect]![position];
  const rectWidth = widthRatio * width;
  const rectHeight = rectWidth * WATERMARK_ASSET_RATIO;
  return {
    x: xRatio * width,
    y: height - yRatio * height - rectHeight,
    width: rectWidth,
    height: rectHeight,
  };
}

let assetPromise: Promise<HTMLImageElement> | null = null;

export function loadWatermarkAsset(): Promise<HTMLImageElement> {
  assetPromise ??= new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => {
      assetPromise = null;
      reject(new Error("Watermark asset failed to load"));
    };
    image.src = watermarkAssetUrl();
  });
  return assetPromise;
}

/** Draw the official watermark onto a canvas containing the image. Browser only. */
export async function drawWatermark(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  settings: WatermarkSettings,
): Promise<void> {
  if (!settings.enabled) return;
  const asset = await loadWatermarkAsset();
  const rect = watermarkRect(width, height, settings.position);
  ctx.drawImage(asset, rect.x, rect.y, rect.width, rect.height);
}
