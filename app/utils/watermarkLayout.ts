import type { WatermarkPosition } from "./watermark";

/**
 * Official Insta360 Luna Ultra watermark placement table, extracted from
 * luna-ai-cut (src/shared/watermark/layoutConfig/luna-ultra). Values are
 * [widthRatio, xRatio, yRatio]: watermark width and left edge as fractions of
 * image width, and the gap below the watermark as a fraction of image height
 * (measured from the bottom edge).
 */
export const LUNA_WATERMARK_LAYOUT: Record<
  string,
  Record<WatermarkPosition, [number, number, number]>
> = {
  "16:9": {
    "bottom-left": [0.191, 0.033, 0.059],
    "bottom-right": [0.191, 0.776, 0.059],
    "top-left": [0.191, 0.033, 0.88],
    "top-right": [0.191, 0.776, 0.88],
    "bottom-center": [0.191, 0.404, 0.059],
  },
  "4:1": {
    "bottom-left": [0.167, 0.033, 0.133],
    "bottom-right": [0.167, 0.799, 0.133],
    "top-left": [0.167, 0.033, 0.746],
    "top-right": [0.167, 0.799, 0.746],
    "bottom-center": [0.167, 0.416, 0.133],
  },
  "4:3": {
    "bottom-left": [0.255, 0.044, 0.059],
    "bottom-right": [0.255, 0.701, 0.059],
    "top-left": [0.255, 0.044, 0.88],
    "top-right": [0.255, 0.701, 0.88],
    "bottom-center": [0.255, 0.373, 0.059],
  },
  "9:16": {
    "bottom-left": [0.34, 0.087, 0.033],
    "bottom-right": [0.34, 0.573, 0.033],
    "top-left": [0.34, 0.087, 0.817],
    "top-right": [0.34, 0.573, 0.817],
    "bottom-center": [0.34, 0.33, 0.033],
  },
  "1:1": {
    "bottom-left": [0.297, 0.059, 0.059],
    "bottom-right": [0.297, 0.643, 0.059],
    "top-left": [0.297, 0.059, 0.887],
    "top-right": [0.297, 0.643, 0.887],
    "bottom-center": [0.297, 0.351, 0.059],
  },
  "3:4": {
    "bottom-left": [0.34, 0.059, 0.044],
    "bottom-right": [0.34, 0.601, 0.044],
    "top-left": [0.34, 0.059, 0.91],
    "top-right": [0.34, 0.601, 0.91],
    "bottom-center": [0.34, 0.33, 0.044],
  },
  "100:235": {
    "bottom-left": [0.34, 0.087, 0.025],
    "bottom-right": [0.34, 0.573, 0.025],
    "top-left": [0.34, 0.087, 0.769],
    "top-right": [0.34, 0.573, 0.769],
    "bottom-center": [0.34, 0.33, 0.025],
  },
  "235:100": {
    "bottom-left": [0.145, 0.025, 0.059],
    "bottom-right": [0.145, 0.83, 0.059],
    "top-left": [0.145, 0.025, 0.88],
    "top-right": [0.145, 0.83, 0.88],
    "bottom-center": [0.145, 0.428, 0.059],
  },
  "3:2": {
    "bottom-left": [0.191, 0.033, 0.05],
    "bottom-right": [0.191, 0.776, 0.05],
    "top-left": [0.191, 0.033, 0.898],
    "top-right": [0.191, 0.776, 0.898],
    "bottom-center": [0.191, 0.404, 0.05],
  },
  "2:3": {
    "bottom-left": [0.287, 0.05, 0.033],
    "bottom-right": [0.287, 0.663, 0.033],
    "top-left": [0.287, 0.05, 0.932],
    "top-right": [0.287, 0.663, 0.932],
    "bottom-center": [0.287, 0.357, 0.033],
  },
  "3:1": {
    "bottom-left": [0.167, 0.033, 0.1],
    "bottom-right": [0.167, 0.799, 0.1],
    "top-left": [0.167, 0.033, 0.81],
    "top-right": [0.167, 0.799, 0.81],
    "bottom-center": [0.167, 0.416, 0.1],
  },
  "27:10": {
    "bottom-left": [0.167, 0.033, 0.09],
    "bottom-right": [0.167, 0.799, 0.09],
    "top-left": [0.167, 0.033, 0.829],
    "top-right": [0.167, 0.799, 0.829],
    "bottom-center": [0.167, 0.416, 0.09],
  },
  "20:47": {
    "bottom-left": [0.34, 0.087, 0.025],
    "bottom-right": [0.34, 0.573, 0.025],
    "top-left": [0.34, 0.087, 0.769],
    "top-right": [0.34, 0.573, 0.769],
    "bottom-center": [0.34, 0.33, 0.025],
  },
  "47:20": {
    "bottom-left": [0.145, 0.037, 0.059],
    "bottom-right": [0.145, 0.818, 0.059],
    "top-left": [0.145, 0.037, 0.88],
    "top-right": [0.145, 0.818, 0.88],
    "bottom-center": [0.145, 0.428, 0.059],
  },
  "10:27": {
    "bottom-left": [0.34, 0.059, 0.022],
    "bottom-right": [0.34, 0.601, 0.022],
    "top-left": [0.34, 0.059, 0.799],
    "top-right": [0.34, 0.601, 0.799],
    "bottom-center": [0.34, 0.33, 0.022],
  },
};
