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
