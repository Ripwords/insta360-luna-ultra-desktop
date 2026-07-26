/**
 * Declarative description of the settings panel.
 *
 * Every control names the option type the camera expects alongside the field
 * it writes — those two are separate vocabularies with confusingly similar
 * names, and pairing them here is what stops them drifting apart. Only
 * options the probe confirmed the camera acknowledges appear.
 */

export type ControlKind = "select" | "toggle" | "steps";

export interface Control {
  kind: ControlKind;
  label: string;
  field: string;
  option: string;
  /** Fully qualified enum name, for `kind: "select"`. */
  values?: string;
  /** Discrete numeric choices, for `kind: "steps"`. */
  steps?: Array<{ value: number; label: string }>;
  /** Device options live on Options rather than PhotographyOptions. */
  scope?: "device";
  hint?: string;
}

export interface ControlSection {
  title: string;
  controls: Control[];
}

const numbered = (values: number[], suffix = ""): Array<{ value: number; label: string }> =>
  values.map((value) => ({ value, label: `${value}${suffix}` }));

const PO = "insta360.messages.PhotographyOptions";

export const CONTROL_SECTIONS: ControlSection[] = [
  {
    title: "Exposure",
    controls: [
      {
        kind: "select",
        label: "Exposure mode",
        field: "exposure_mode",
        option: "EXPOSURE_MODE",
        values: `${PO}.ExposureMode`,
      },
      {
        kind: "select",
        label: "Metering",
        field: "meter_mode",
        option: "AE_METER_MODE",
        values: `${PO}.AEMeterMode`,
      },
      {
        kind: "toggle",
        label: "Metering enabled",
        field: "metering_enable",
        option: "METERING_ENABLE",
      },
      {
        kind: "steps",
        label: "ISO ceiling",
        field: "video_iso_top_limit",
        option: "VIDEO_ISO_TOP_LIMIT",
        steps: [{ value: 0, label: "Auto" }, ...numbered([400, 800, 1600, 3200, 6400])],
      },
    ],
  },
  {
    title: "Colour",
    controls: [
      {
        kind: "select",
        label: "White balance",
        field: "white_balance",
        option: "WHITE_BALANCE",
        values: `${PO}.WhiteBalance`,
      },
      {
        kind: "steps",
        label: "Colour temperature",
        field: "white_balance_value",
        option: "WHITE_BALANCE_VALUE",
        steps: [
          { value: 0, label: "Auto" },
          ...numbered([2700, 3200, 4000, 5000, 5600, 6500, 7500], "K"),
        ],
        hint: "Applies when white balance is not automatic",
      },
      {
        kind: "select",
        label: "Colour mode",
        field: "color_mode",
        option: "COLOR_MODE",
        values: `${PO}.COLOR_MODE`,
      },
      {
        // Named "Gamma" until the camera showed otherwise: stepping through the
        // Filter picker is what moves gamma_mode, and nothing else does.
        kind: "select",
        label: "Filter",
        field: "gamma_mode",
        option: "VIDEO_GAMMA_MODE",
        values: "insta360.messages.GammaMode",
      },
      {
        kind: "select",
        label: "Filter strength",
        field: "filter_intensity",
        option: "FILTER_INTENSITY",
        values: "insta360.messages.FilterIntensity",
        hint: "Cinematic filters only — the Leica profiles have no strength",
      },
      {
        kind: "select",
        label: "Flicker",
        field: "flicker",
        option: "FLICKER",
        values: "insta360.messages.Flicker",
      },
      {
        kind: "steps",
        label: "Brightness",
        field: "brightness",
        option: "BRIGHTNESS",
        steps: numbered([-2, -1, 0, 1, 2]),
      },
      {
        kind: "steps",
        label: "Contrast",
        field: "contrast",
        option: "CONTRAST",
        steps: numbered([0, 1, 2, 3, 4]),
      },
      {
        kind: "steps",
        label: "Saturation",
        field: "saturation",
        option: "SATURATION",
        steps: numbered([0, 1, 2, 3, 4]),
      },
      {
        kind: "steps",
        label: "Hue",
        field: "hue",
        option: "HUE",
        steps: numbered([-2, -1, 0, 1, 2]),
      },
      {
        kind: "steps",
        label: "Sharpness",
        field: "sharpness",
        option: "SHARPNESS",
        steps: [
          { value: 0, label: "Off" },
          { value: 1, label: "Low" },
          { value: 2, label: "Medium" },
          { value: 3, label: "High" },
          { value: 4, label: "Max" },
        ],
      },
    ],
  },
  {
    title: "Format",
    controls: [
      {
        kind: "select",
        label: "Video resolution",
        field: "record_resolution",
        option: "RECORD_RESOLUTION",
        values: "insta360.messages.VideoResolution",
        hint: "The camera rejects resolutions this mode does not offer",
      },
      {
        kind: "select",
        label: "Photo size",
        field: "photo_resolution",
        option: "PHOTO_RESOLUTION",
        values: "insta360.messages.PhotoSize",
      },
      {
        kind: "select",
        label: "Field of view",
        field: "fov_type",
        option: "FOV_TYPE",
        values: `${PO}.Fov_Type`,
      },
      {
        kind: "select",
        label: "RAW capture",
        field: "raw_capture_type",
        option: "RAW_CAPTURE_TYPE",
        values: "insta360.messages.RawCaptureType",
      },
      {
        kind: "steps",
        label: "Video bitrate",
        field: "video_bitrate",
        option: "PHOTO_GRAPHY_BITRATE",
        steps: numbered([40, 60, 80, 100, 120], " Mbps"),
      },
    ],
  },
  {
    title: "Capture",
    controls: [
      {
        kind: "steps",
        label: "Self-timer",
        field: "photography_self_timer",
        option: "PHOTOGRAPHY_SELF_TIMER",
        steps: [{ value: 0, label: "Off" }, ...numbered([3, 5, 10, 20], "s")],
      },
      {
        kind: "steps",
        label: "AEB frames",
        field: "aeb_capture_num",
        option: "AEB_CAPTURE_NUM",
        steps: numbered([1, 3, 5, 7]),
      },
      {
        kind: "steps",
        label: "Burst frames",
        field: "burst_capture_num",
        option: "BURST_CAPTURE_NUM",
        steps: numbered([0, 3, 5, 10, 20, 30]),
      },
      {
        kind: "steps",
        label: "Burst window",
        field: "burst_capture_time",
        option: "BURST_CAPTURE_TIME",
        steps: [{ value: 0, label: "Off" }, ...numbered([1, 2, 3, 5], "s")],
      },
      {
        kind: "toggle",
        label: "Pre-record cache",
        field: "cache_capture_enable",
        option: "CACHE_CAPTURE_ENABLE",
      },
    ],
  },
  {
    title: "Stabilisation",
    controls: [
      {
        kind: "toggle",
        label: "FlowState",
        field: "flowstate_base_enable",
        option: "FLOWSTATE_BASE_TYPE",
      },
      {
        kind: "toggle",
        label: "Low-light EIS",
        field: "dark_eis_enable",
        option: "DARK_EIS_ENABLE",
      },
      {
        kind: "toggle",
        label: "Sport mode preview",
        field: "preview_sport_mode_enable",
        option: "PREVIEW_SPORT_MODE_ENABLE",
      },
      {
        kind: "toggle",
        label: "Preview noise reduction",
        field: "preview_mctf_enable",
        option: "PREVIEW_MCTF_ENABLE",
      },
    ],
  },
  {
    title: "Device",
    controls: [
      { kind: "toggle", label: "Mute microphone", field: "mute", option: "MUTE", scope: "device" },
    ],
  },
];

/**
 * White balance is two rival fields: the `white_balance` preset enum and the
 * free-Kelvin `white_balance_value`. The camera only honours the Kelvin when the
 * preset is non-auto, so a preset written on its own (with the Kelvin left at 0)
 * reconciles back to auto and appears to do nothing. Pairing each preset with
 * its Kelvin and writing both keeps them consistent.
 */
export const WHITE_BALANCE_KELVIN: Record<string, number> = {
  WB_AUTO: 0,
  WB_2700K: 2700,
  WB_4000K: 4000,
  WB_5000K: 5000,
  WB_6500K: 6500,
  WB_7500K: 7500,
};
