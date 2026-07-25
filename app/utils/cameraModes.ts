/**
 * The camera's shooting modes.
 *
 * A mode is three linked facts: the sub-mode option that selects it, the
 * function mode its photographic settings are stored under, and — for video —
 * the capture mode `START_CAPTURE` expects. Keeping them together stops the
 * three drifting apart, which is easy to do since they use different enums
 * with similar names.
 */

/**
 * Pano HDR is deliberately absent. The shared schema defines PHOTO_INSTA_PANO_HDR
 * and FUNCTION_MODE_HDR_POWER_PANO_IMAGE, but the Luna Ultra has no such mode —
 * the schema describes a different camera, as it does for the colour enums.
 *
 * Pano's own 360 and 2:1 UltraPhoto variants are not here either, because their
 * sub-mode values have not been measured. The camera was seen reporting
 * photo_sub_mode = 8, which the schema cannot name, so guessing at these would
 * be inventing numbers. Measure them with probe-colorspace.mjs before adding.
 */
export type CaptureModeId = "video" | "pure" | "slowmo" | "photo" | "pano" | "timelapse";

export interface CameraMode {
  id: CaptureModeId;
  label: string;
  /** Option type that selects this mode. */
  optionType: "VIDEO_SUB_MODE" | "PHOTO_SUB_MODE";
  /** Field on Options that carries the sub-mode. */
  field: "video_sub_mode" | "photo_sub_mode";
  subMode: string;
  functionMode: string;
  /** Stills modes use TAKE_PICTURE; video modes use START_CAPTURE with this. */
  captureMode?: string;
}

export const CAPTURE_MODES: CameraMode[] = [
  {
    id: "video",
    label: "Video",
    optionType: "VIDEO_SUB_MODE",
    field: "video_sub_mode",
    subMode: "VIDEO_NORMAL",
    functionMode: "FUNCTION_MODE_NORMAL_VIDEO",
    captureMode: "Capture_MODE_NORMAL",
  },
  {
    id: "pure",
    label: "Pure",
    optionType: "VIDEO_SUB_MODE",
    field: "video_sub_mode",
    subMode: "VIDEO_PURE",
    functionMode: "FUNCTION_MODE_NORMAL_VIDEO",
    captureMode: "Capture_MODE_PURE_VIDEO",
  },
  {
    id: "slowmo",
    label: "Slow-mo",
    optionType: "VIDEO_SUB_MODE",
    field: "video_sub_mode",
    subMode: "VIDEO_SLOW_MOTION",
    functionMode: "FUNCTION_MODE_SLOWMOTION_VIDEO",
    captureMode: "Capture_MODE_SLOWMOTION",
  },
  {
    id: "photo",
    label: "Photo",
    optionType: "PHOTO_SUB_MODE",
    field: "photo_sub_mode",
    subMode: "PHOTO_SINGLE",
    functionMode: "FUNCTION_MODE_NORMAL_IMAGE",
  },
  {
    id: "pano",
    label: "Pano",
    optionType: "PHOTO_SUB_MODE",
    field: "photo_sub_mode",
    subMode: "PHOTO_INSTA_PANO",
    functionMode: "FUNCTION_MODE_NORMAL_POWER_PANO_IMAGE",
  },
  {
    id: "timelapse",
    label: "Timelapse",
    optionType: "VIDEO_SUB_MODE",
    field: "video_sub_mode",
    subMode: "VIDEO_TIMELAPSE",
    functionMode: "FUNCTION_MODE_MOBILE_TIMELAPSE",
    captureMode: "Capture_MODE_NORMAL",
  },
];

export const findMode = (id: string): CameraMode | undefined =>
  CAPTURE_MODES.find((mode) => mode.id === id);

export const isPhotoMode = (id: string): boolean => findMode(id)?.captureMode === undefined;

/**
 * Work out which mode the camera is currently in. Video wins when it reports
 * anything other than VIDEO_NONE, because the camera leaves the other
 * sub-mode at its "none" sentinel rather than clearing it.
 */
export function modeForState(
  videoSubMode: string | undefined,
  photoSubMode: string | undefined,
): CameraMode | null {
  if (videoSubMode && videoSubMode !== "VIDEO_NONE") {
    return CAPTURE_MODES.find((mode) => mode.subMode === videoSubMode) ?? null;
  }
  if (photoSubMode && photoSubMode !== "PHOTO_NONE") {
    return CAPTURE_MODES.find((mode) => mode.subMode === photoSubMode) ?? null;
  }
  return null;
}
