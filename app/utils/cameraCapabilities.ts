/**
 * What each capture mode can actually do, per Insta360's Luna Ultra manual.
 *
 * The camera does not advertise these rules over the protocol: `$supported`
 * lists the option *types* it will parse, and it happily parses COLOR_MODE in
 * modes where its own UI has no colour picker at all. So offering a control
 * purely because the option type is supported produces settings that write
 * cleanly, read back cleanly, and change nothing — the exact failure mode that
 * made colour mode look broken for so long.
 *
 * Every rule here is transcribed from documentation, with its source noted.
 * Nothing is inferred: where the manual is silent, the control stays available
 * rather than being guessed away.
 *
 * Sources:
 * - Basic Mode and Pro Mode — which modes expose a Color Mode picker
 *   https://onlinemanual.insta360.com/lunaultra/en-us/operation-tutorials/shooting-preview/shooting-specs/normal-professional-mode
 * - I-Log Mode — video-only, and what it is mutually exclusive with
 *   https://onlinemanual.insta360.com/lunaultra/en-us/operation-tutorials/shooting-preview/shooting-specs/i-log
 */

import type { CaptureModeId } from "~/utils/cameraModes";
import { resolutionParts } from "~/utils/cameraLabels";

/** Every colour mode this firmware has, in the order the camera lists them. */
const ALL_COLOR_MODES = ["COLOR_MODE_NORMAL", "COLOR_MODE_LOG", "COLOR_MODE_HDR"] as const;

const STANDARD_ONLY = ["COLOR_MODE_NORMAL"];

/**
 * What colour modes each capture mode can shoot, confirmed on-device.
 *
 * Only plain Video gets the full choice. PureVideo, Slow-mo and Timelapse are
 * Standard and nothing else, and Photo and Pano have no picker at all — an
 * absent entry means no control rather than an unrestricted one, so a mode added
 * later shows nothing until someone establishes what it can do.
 */
const COLOR_MODES_BY_CAPTURE_MODE: Partial<Record<CaptureModeId, readonly string[]>> = {
  video: ALL_COLOR_MODES,
  pure: STANDARD_ONLY,
  slowmo: STANDARD_ONLY,
  timelapse: STANDARD_ONLY,
};

/**
 * Modes that must be forced back to Standard with no filter on the way in.
 *
 * The camera does not do this for you: switching into one of these from i-Log or
 * Dolby Vision leaves `color_mode` where it was, so the app would be showing
 * Standard (the only value it offers here) while the camera shot something else
 * — the same class of lie as reading a stale enum. Entering the mode writes the
 * reset rather than assuming it.
 */
const RESET_TO_STANDARD = new Set<CaptureModeId>(["pano", "pure", "slowmo", "timelapse"]);

/** Whether entering this mode should force Standard colour and no filter. */
export const resetsToStandard = (modeId: string): boolean =>
  RESET_TO_STANDARD.has(modeId as CaptureModeId);

/**
 * The six cinematic filters, which are the only ones with a strength control:
 * "Six cinematic filters offer three intensity levels", and separately "Leica
 * color profiles do not support intensity adjustment".
 *
 * Measurement agrees — stepping a cinematic filter through Low/Medium/High
 * moved `filter_intensity` 1/2/3, while it just held its global value across
 * filters that have no strength of their own.
 */
const FILTERS_WITH_INTENSITY = new Set([
  "FILTER_POS_FILM",
  "FILTER_NEG_FILM",
  "FILTER_CC_FILM",
  "FILTER_NC_FILM",
  "FILTER_FRESH",
  "FILTER_CINEMATIC",
]);

/** Whether the chosen filter offers Low/Medium/High. */
export const filterHasIntensity = (filter: string | undefined): boolean =>
  filter !== undefined && FILTERS_WITH_INTENSITY.has(filter);

/**
 * Colour modes with no filter picker.
 *
 * Dolby Vision is the only one, and the list is complete: all three modes were
 * checked on-device, and Standard and i-Log both allow filters. The manual is
 * wrong here — its filters page lists Dolby Vision as filter-supporting, while
 * the camera offers no picker there at all and passing *through* Dolby Vision
 * clears whatever filter was set. Where documentation and hardware disagree,
 * the hardware wins.
 */
const COLOR_MODES_WITHOUT_FILTERS = new Set(["COLOR_MODE_HDR"]);

/**
 * Whether filters are available in the camera's current state.
 *
 * Two independent rules: the colour mode has to allow them at all, and the
 * recording resolution has to be within "Video at 4K@60fps or lower" — no 8K, no
 * high frame rates. Resolution names carry both numbers (RES_3840_2160P60), so
 * that half reads straight off the name.
 *
 * Anything unreadable is treated as supported. Offering a control the camera
 * then refuses is a visible, recoverable error; hiding one it actually has is
 * invisible, and we would never hear about it.
 */
export function supportsFilter(state: { resolution?: string; colorMode?: string }): boolean {
  if (state.colorMode && COLOR_MODES_WITHOUT_FILTERS.has(state.colorMode)) return false;
  if (!state.resolution) return true;
  const match = /^RES_(\d+)_\d+P(\d+)$/.exec(state.resolution);
  if (!match) return true;
  return Number(match[1]) <= 3840 && Number(match[2]) <= 60;
}

/**
 * Whether this capture mode has a 360 / 2:1 aspect choice.
 *
 * Only Pano does. Pano is a single sub-mode on this camera — `photo_sub_mode`
 * reads 8 for both aspects — with the choice carried on its own field, which is
 * why the shared schema has one PHOTO_INSTA_PANO and no variants.
 */
export const supportsPanoAspect = (modeId: string): boolean => modeId === "pano";

/** Whether this capture mode shows a Color Mode readout at all. */
export const supportsColorMode = (modeId: string): boolean =>
  COLOR_MODES_BY_CAPTURE_MODE[modeId as CaptureModeId] !== undefined;

/**
 * The colour modes selectable in this capture mode, in camera order. Empty when
 * the mode has no picker, which callers use to hide the control outright.
 *
 * A single-entry list is deliberate rather than a reason to hide the control:
 * "Standard, and that is the only choice here" is worth showing, where a missing
 * chip would leave you wondering what the camera is shooting.
 */
export const colorModesFor = (modeId: string): string[] => [
  ...(COLOR_MODES_BY_CAPTURE_MODE[modeId as CaptureModeId] ?? []),
];

/**
 * Recording resolutions, measured on the camera and nothing else.
 *
 * The `VideoResolution` enum cannot be used as the source here. It carries 229
 * entries describing a 2020 camera, most of which this one does not offer, and
 * it was missing whole families until they were measured and added. Offering an
 * entry we have not seen the camera produce would be offering a number it may
 * not recognise, which fails the way everything else in this protocol fails —
 * accepted, read back, ignored.
 *
 * So this list only grows by measurement. See
 * docs/superpowers/specs/2026-07-25-camera-protocol-calibration.md, and
 * PENDING_RESOLUTIONS below for the ones still waiting on a name.
 */
export const MEASURED_RESOLUTIONS = [
  "RES_7680_4320P30",
  "RES_7680_4320P25",
  "RES_7680_4320P24",
  "RES_3840_2160P120",
  "RES_3840_2160P100",
  "RES_3840_2160P50",
  "RES_3840_2160P30",
  "RES_3840_2160P24",
  "RES_1920_1080P240",
  "RES_1920_1080P200",
  "RES_1920_1080P120",
  "RES_1920_1080P100",
  "RES_1920_1080P60",
  "RES_1920_1080P50",
  "RES_1920_1080P30",
  "RES_1920_1080P25",
  "RES_1920_1080P24",
  // Named from the camera's screen in a later pass
  "RES_3840_2160P48",
  "RES_1920_1080P48",
  "RES_3840_1632P120",
  "RES_3840_1632P100",
  "RES_3840_1632P60",
  "RES_3840_1632P48",
  "RES_3840_1632P30",
  "RES_3840_1632P25",
  "RES_3840_1632P24",
  "RES_3072_3072P60",
  "RES_3072_3072P50",
  "RES_3840_1632P50",
  "RES_2688_1520P120",
  "RES_2688_1520P100",
  "RES_2688_1520P60",
  "RES_2688_1520P50",
  "RES_2688_1520P48",
  "RES_2688_1520P30",
  "RES_2688_1520P25",
  "RES_2688_1520P24",
];

/**
 * Values the camera was seen to use that we cannot name yet. Currently none —
 * every number observed on the wire has been named from the camera's screen.
 *
 * TO ADD ONE:
 *   1. `node scripts/probe-colorspace.mjs monitor`, set it on the camera, and
 *      type what the screen says when the probe asks.
 *   2. Add the number and name to ENUM_ADDITIONS for
 *      `insta360.messages.VideoResolution` in scripts/build-schema.mjs, using
 *      the RES_<width>_<height>P<fps> form, then `node scripts/build-schema.mjs`.
 *   3. Add it to MEASURED_RESOLUTIONS. The per-mode rules below pick it up.
 *
 * Do NOT infer one from its position in the picker. That was tried once: 258
 * sat exactly where 4K25 belongs and was read as such, and the camera's screen
 * said 4K48.
 */
export const PENDING_RESOLUTIONS: number[] = [];

/** Split `RES_3840_2160P120` into the parts the per-mode rules care about. */
function parseResolution(name: string) {
  const match = /^RES_(\d+)_(\d+)P(\d+)$/.exec(name);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]), fps: Number(match[3]) };
}

/**
 * Framerate alone is not a sufficient filter, which cost a bug: 8K tops out at
 * 30fps, so a rule of "60 and below" happily admitted it to PureVideo and a
 * rule of "30 only" admitted it to Timelapse, neither of which shoots 8K.
 * Every rule below constrains the frame size as well.
 */
const rule =
  (maxWidth: number, fps: number[], allowSquare = false) =>
  (name: string) => {
    const res = parseResolution(name);
    if (!res) return false;
    if (res.width > maxWidth) return false;
    if (!allowSquare && res.width === res.height) return false;
    return fps.includes(res.fps);
  };

/**
 * Which resolutions each mode offers, from the manual's per-mode tables
 * intersected with what we have measured. A mode with no entry gets no picker
 * rather than an unrestricted one.
 */
const RESOLUTIONS_BY_CAPTURE_MODE: Partial<Record<CaptureModeId, readonly string[]>> = {
  video: MEASURED_RESOLUTIONS,
  // "4K / 3K 9:16 / 2.7K / 1080p at 24-60" — no 8K, and the 1:1 crop is
  // Video-only, so the square frames are excluded here too
  pure: MEASURED_RESOLUTIONS.filter(rule(3840, [60, 50, 48, 30, 25, 24])),
  // "4K and 2.7K at 100/120; 1080p also 200/240"
  slowmo: MEASURED_RESOLUTIONS.filter(rule(3840, [240, 200, 120, 100])),
  // "4K / 2.7K / 1080p at 30 only"
  timelapse: MEASURED_RESOLUTIONS.filter(rule(3840, [30])),
};

/** The recording resolutions this capture mode offers, in the camera's order. */
export const resolutionsFor = (modeId: string): string[] => [
  ...(RESOLUTIONS_BY_CAPTURE_MODE[modeId as CaptureModeId] ?? []),
];

/**
 * The three pickers, each narrowed by the one before it.
 *
 * Order matters and is not alphabetical: sizes run largest first and framerates
 * fastest first, because that is how a camera lists them and how you think about
 * them. Each list is derived from what this mode actually offers, so a choice
 * can never strand you on a combination that does not exist — 8K has no 120fps,
 * and coming from 4K120 has to land somewhere real.
 */
const SIZE_ORDER = ["8K", "4K", "3K", "2.7K", "1080p"];
const ASPECT_ORDER = ["16:9", "2.35:1", "1:1", "9:16"];

const partsFor = (modeId: string) =>
  resolutionsFor(modeId)
    .map((name) => resolutionParts(name))
    .filter((parts): parts is NonNullable<typeof parts> => parts !== null);

const ordered = <T>(values: Iterable<T>, order: T[]): T[] =>
  [...new Set(values)].sort((a, b) => order.indexOf(a) - order.indexOf(b));

/** Frame sizes this mode offers, largest first. */
export const sizesFor = (modeId: string): string[] =>
  ordered(
    partsFor(modeId).map((parts) => parts.size),
    SIZE_ORDER,
  );

/** Aspects that frame size has in this mode. */
export const aspectsFor = (modeId: string, size: string): string[] =>
  ordered(
    partsFor(modeId)
      .filter((parts) => parts.size === size)
      .map((parts) => parts.aspect),
    ASPECT_ORDER,
  );

/** Framerates that size and aspect have in this mode, fastest first. */
export const fpsFor = (modeId: string, size: string, aspect: string): number[] =>
  [
    ...new Set(
      partsFor(modeId)
        .filter((parts) => parts.size === size && parts.aspect === aspect)
        .map((parts) => parts.fps),
    ),
  ].sort((a, b) => b - a);
