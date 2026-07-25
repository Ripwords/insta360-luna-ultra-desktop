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
