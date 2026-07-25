/**
 * Human labels for the camera's exposure enums.
 *
 * The ShutterSpeed enum encodes its values in the name: `D` is a division bar
 * and `P` a decimal point, so `SPEED_1D8000` is 1/8000 and `SPEED_1P6` is
 * 1.6 seconds. Decoding that yields exactly the wheel the phone app shows.
 */

import { enumNames } from "~/utils/lunaProto";

export const SHUTTER_SPEED_ENUM = "insta360.messages.PhotographyOptions.ShutterSpeed";

export interface WheelStep {
  value: string;
  label: string;
}

const NUMERIC = /^\d+(?:P\d+)?P?$/;

/** `1P6` -> `1.6`, `12P5` -> `12.5`, `8P` -> `8`. */
const decimal = (part: string): string => part.replace(/P(\d+)/, ".$1").replace(/P$/, "");

export function shutterLabel(name: string): string {
  if (name === "SPEED_AUTO") return "Auto";
  if (!name.startsWith("SPEED_")) return name;

  const body = name.slice("SPEED_".length);
  const [numerator, denominator, ...rest] = body.split("D");
  if (rest.length > 0 || !numerator || !NUMERIC.test(numerator)) return name;

  if (denominator === undefined) return `${decimal(numerator)}s`;
  if (!NUMERIC.test(denominator)) return name;
  return `${decimal(numerator)}/${decimal(denominator)}`;
}

export const shutterSteps = (): WheelStep[] =>
  enumNames(SHUTTER_SPEED_ENUM).map((value) => ({ value, label: shutterLabel(value) }));

/**
 * A ShutterSpeed enum name as exposure time in seconds — the raw double the
 * camera's video_exposure/still_exposure fields expect. `SPEED_1D120` is 1/120,
 * `SPEED_1P3` is 1.3s. Auto (or anything unparseable) is 0.
 */
export function shutterSeconds(name: string): number {
  if (!name.startsWith("SPEED_") || name === "SPEED_AUTO") return 0;
  const toNum = (part: string): number => Number(part.replace(/P(\d+)/, ".$1").replace(/P$/, ""));
  const [numerator, denominator] = name.slice("SPEED_".length).split("D");
  const n = toNum(numerator ?? "");
  if (!Number.isFinite(n)) return 0;
  if (denominator === undefined) return n;
  const d = toNum(denominator);
  return d ? n / d : 0;
}

/**
 * Names the camera's own UI uses, where the raw enum value would not match it.
 * "COLOR_MODE_NORMAL" is "Standard" on the camera, "COLOR_MODE_LOG" is "i-Log",
 * and so on. Anything not listed falls back to a tidied form of its enum name.
 */
const FRIENDLY_LABELS: Record<string, string> = {
  // color_mode — the camera's "Color Mode" picker (Standard / i-Log / Dolby Vision)
  COLOR_MODE_NORMAL: "Standard",
  COLOR_MODE_LOG: "i-Log",
  COLOR_MODE_HDR: "Dolby Vision",
  // white balance presets
  WB_AUTO: "Auto",
  WB_2700K: "2700K",
  WB_4000K: "4000K",
  WB_5000K: "5000K",
  WB_6500K: "6500K",
  WB_7500K: "7500K",
  // gamma_mode — the camera's "Filter" picker: three Leica colour profiles and
  // six cinematic looks, named as the camera names them
  FILTER_NONE: "Original",
  FILTER_LEICA_NATURAL: "Leica Natural",
  FILTER_LEICA_VIVID: "Leica Vivid",
  FILTER_LEICA_CHROME: "Leica Chrome",
  FILTER_POS_FILM: "Pos Film",
  FILTER_NEG_FILM: "Neg Film",
  FILTER_CC_FILM: "CC Film",
  FILTER_NC_FILM: "NC Film",
  FILTER_FRESH: "Fresh",
  FILTER_CINEMATIC: "Cinematic",
  // filter intensity, which only the six cinematic filters offer
  INTENSITY_LOW: "Low",
  INTENSITY_MEDIUM: "Medium",
  INTENSITY_HIGH: "High",
  // pano_aspect — Pano's 360 / 2:1 choice
  PANO_ASPECT_360: "360",
  PANO_ASPECT_2_1: "2:1",
};

/** Label an enum value the way the camera does, or tidy its name if unlisted. */
export const optionLabel = (value: string): string =>
  FRIENDLY_LABELS[value] ?? value.replace(/_/g, " ");

/**
 * Enum values the Luna Ultra does not actually offer, hidden from the pickers.
 *
 * Empty, and worth keeping that way. This list used to paper over two enums the
 * extraction got wrong — COLOR_MODE's phantom "Vivid" and gamma_mode's
 * Urban/Ocean Blue/Snow/… looks. Both are now corrected at the source (see the
 * overrides in scripts/build-schema.mjs), so the enums name only what the camera
 * has and there is nothing left to filter. Hiding a wrong value was always a
 * worse fix than not having the wrong value.
 */
const HIDDEN_OPTIONS = new Set<string>([]);

/** Enum values worth offering in a picker — drops ones this camera doesn't have. */
export const visibleEnumNames = (enumName: string): string[] =>
  enumNames(enumName).filter((value) => !HIDDEN_OPTIONS.has(value));

/** The nearest ShutterSpeed enum name for a raw seconds value, for showing the
 * wheel's current position back (video_exposure stores seconds, the wheel picks
 * enum steps). 0 seconds is Auto. */
export function shutterNameForSeconds(seconds: number): string {
  if (!seconds) return "SPEED_AUTO";
  let best = "SPEED_AUTO";
  let bestDiff = Infinity;
  for (const value of enumNames(SHUTTER_SPEED_ENUM)) {
    if (value === "SPEED_AUTO") continue;
    const diff = Math.abs(shutterSeconds(value) - seconds);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = value;
    }
  }
  return best;
}

/** The camera treats ISO 0 as automatic. */
export const isoLabel = (value: number): string => (value === 0 ? "Auto" : String(value));

export const ISO_STEPS = [0, 100, 200, 400, 800, 1600, 3200, 6400];

export const isoSteps = (): WheelStep[] =>
  ISO_STEPS.map((value) => ({ value: String(value), label: isoLabel(value) }));

/**
 * The zoom dial, 1x to 12x.
 *
 * `zoom_scale` is a double and the camera takes anything in range, so this is a
 * continuous control rather than a set of stops — the dial is dragged.
 *
 * Position maps to zoom logarithmically, the way a lens barrel is marked: going
 * 1x to 2x reframes the shot far more than 11x to 12x does, so the wide end
 * earns more travel. Linear would squeeze everything useful into a sliver at
 * the bottom of the dial.
 */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 12;

const ZOOM_RANGE = Math.log(ZOOM_MAX / ZOOM_MIN);

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/** Where along the dial (0 at the wide end, 1 at the long end) a zoom sits. */
export const zoomFraction = (scale: number): number =>
  clamp(Math.log(clamp(scale, ZOOM_MIN, ZOOM_MAX) / ZOOM_MIN) / ZOOM_RANGE, 0, 1);

/** The zoom for a position on the dial, rounded to the 0.1 the label shows. */
export function zoomForFraction(fraction: number): number {
  const scale = ZOOM_MIN * Math.exp(clamp(fraction, 0, 1) * ZOOM_RANGE);
  return Math.round(clamp(scale, ZOOM_MIN, ZOOM_MAX) * 10) / 10;
}

/**
 * `4.9x`, and `2x` rather than `2.0x` — a trailing zero reads as precision the
 * dial does not have, and it makes the label jitter in width as you drag.
 */
export const zoomLabel = (scale: number): string => `${Math.round(scale * 10) / 10}x`;

/** Marked stops on the dial. Everything between them is a plain tick. */
export const ZOOM_MARKS = [1, 2, 3, 5, 8, 12];

/**
 * Resolutions, split into the three things you actually choose between.
 *
 * A single list of every combination is 37 entries long and useless to pick
 * from — you end up scrolling past 8K to reach 1080p60. But 37 combinations are
 * really a handful of frame sizes times a handful of aspects times a handful of
 * framerates, so the honest control is three short lists, not one long one.
 *
 * Frame size and aspect both live in the dimensions, which is why they are
 * derived here rather than stored: 3840x2160 is 4K at 16:9, and 3840x1632 is
 * the same 4K sensor read at 2.35:1.
 */
export interface ResolutionParts {
  size: string;
  aspect: string;
  fps: number;
}

/** Every frame size this camera has been seen to use, keyed by dimensions. */
const FRAME_SIZES: Record<string, { size: string; aspect: string }> = {
  "7680x4320": { size: "8K", aspect: "16:9" },
  "7680x3264": { size: "8K", aspect: "2.35:1" },
  "3840x2160": { size: "4K", aspect: "16:9" },
  "3840x1632": { size: "4K", aspect: "2.35:1" },
  "3072x3072": { size: "3K", aspect: "1:1" },
  "1728x3072": { size: "3K", aspect: "9:16" },
  "2688x1520": { size: "2.7K", aspect: "16:9" },
  "1520x2688": { size: "2.7K", aspect: "9:16" },
  "1920x1080": { size: "1080p", aspect: "16:9" },
  "1080x1920": { size: "1080p", aspect: "9:16" },
};

/** `RES_3840_1632P50` -> 4K, 2.35:1, 50. Null when the name is unreadable. */
export function resolutionParts(name: string): ResolutionParts | null {
  const match = /^RES_(\d+)_(\d+)P(\d+)$/.exec(name);
  if (!match) return null;
  const frame = FRAME_SIZES[`${match[1]}x${match[2]}`];
  if (!frame) return null;
  return { ...frame, fps: Number(match[3]) };
}

/** The reverse, for turning three picker choices back into a value to write. */
export function composeResolution(size: string, aspect: string, fps: number): string | null {
  const dimensions = Object.entries(FRAME_SIZES).find(
    ([, frame]) => frame.size === size && frame.aspect === aspect,
  )?.[0];
  if (!dimensions) return null;
  return `RES_${dimensions.replace("x", "_")}P${fps}`;
}

/** `4K 2.35:1 50`, or the raw name if it cannot be read. */
export function resolutionLabel(name: string): string {
  const parts = resolutionParts(name);
  if (!parts) {
    const match = /^RES_(\d+)_(\d+)P(\d+)$/.exec(name);
    return match ? `${match[1]}×${match[2]} ${match[3]}` : name;
  }
  return parts.aspect === "16:9"
    ? `${parts.size} ${parts.fps}`
    : `${parts.size} ${parts.aspect} ${parts.fps}`;
}
