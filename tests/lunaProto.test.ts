import { describe, expect, it } from "vitest";
import {
  MSG,
  decodeMessage,
  encodeMessage,
  enumNames,
  enumValue,
  isDefaultValue,
} from "~/utils/lunaProto";

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)));

describe("decodeMessage", () => {
  it("decodes a real CAMERA_POSTURE response", () => {
    // 085d 1203 e80501 — option_types=93, value{ camera_posture=1 }
    const decoded = decodeMessage(MSG.GetOptionsResp, hex("085d1203e80501"));
    expect(decoded.option_types).toEqual(["CAMERA_POSTURE"]);
    expect((decoded.value as Record<string, unknown>).camera_posture).toBe(
      "CAMERA_POSTURE_ROTATE_90",
    );
  });

  it("decodes a real WINDOW_CROP_INFO response with a nested message", () => {
    const decoded = decodeMessage(
      MSG.GetOptionsResp,
      hex("087c120fe2070c080010001800200028003000"),
    );
    const crop = (decoded.value as Record<string, Record<string, unknown>>).window_crop_info;
    expect(crop).toEqual({
      src_width: 0,
      src_height: 0,
      dst_width: 0,
      dst_height: 0,
      crop_offset_x: 0,
      crop_offset_y: 0,
    });
  });

  it("decodes a real empty PTZ_CTRL response without inventing fields", () => {
    // The camera answered with an empty value and no option_types echo
    const decoded = decodeMessage(MSG.GetOptionsResp, hex("1200"));
    expect(decoded.option_types).toBeUndefined();
    expect(decoded.value).toEqual({});
  });

  it("keeps fields the schema does not know under $unknown", () => {
    // field 200 varint 7 cannot be in GetOptionsResp, which has only 1 and 2
    const decoded = decodeMessage(MSG.GetOptionsResp, hex("c00c07"));
    expect(decoded.$unknown).toEqual([{ field: 200, wire: 0, value: "7" }]);
  });

  it("reports an out-of-range enum as its number, not a crash", () => {
    // photo_sub_mode (field 40) = 5. The extraction called 5 PHOTO_INSTA_PANO;
    // this camera puts Pano on 8 and has nothing on 5, so it has no name and
    // must come back as the raw number rather than a confident wrong label.
    const decoded = decodeMessage(MSG.Options, hex("c00205"));
    expect(decoded.photo_sub_mode).toBe(5);
  });
});

describe("encodeMessage", () => {
  it("encodes a GetPhotographyOptions request the camera accepted", () => {
    // Unpacked repeated enums, matching the captured request shape
    const bytes = encodeMessage(MSG.GetPhotographyOptions, {
      option_types: ["EXPOSURE_MODE", "WHITE_BALANCE"],
      function_mode: "FUNCTION_MODE_NORMAL_VIDEO",
    });
    const decoded = decodeMessage(MSG.GetPhotographyOptions, bytes);
    expect(decoded.option_types).toEqual(["EXPOSURE_MODE", "WHITE_BALANCE"]);
    expect(decoded.function_mode).toBe("FUNCTION_MODE_NORMAL_VIDEO");
  });

  it("round-trips a nested settings write", () => {
    const bytes = encodeMessage(MSG.SetPhotographyOptions, {
      option_types: ["WHITE_BALANCE_VALUE", "EXPOSURE_BIAS"],
      value: { white_balance_value: 5600 },
      function_mode: "FUNCTION_MODE_NORMAL_VIDEO",
    });
    const decoded = decodeMessage(MSG.SetPhotographyOptions, bytes);
    expect(decoded.option_types).toEqual(["WHITE_BALANCE_VALUE", "EXPOSURE_BIAS"]);
    expect((decoded.value as Record<string, unknown>).white_balance_value).toBe(5600);
  });

  it("round-trips a double, which zoom and focal length use", () => {
    const bytes = encodeMessage(MSG.PhotographyOptions, { focal_length_value: 17.4 });
    expect(decodeMessage(MSG.PhotographyOptions, bytes).focal_length_value as number).toBeCloseTo(
      17.4,
      6,
    );
  });

  it("omits proto3 default values, as the camera does", () => {
    expect(encodeMessage(MSG.PhotographyOptions, { exposure_bias: 0 }).length).toBe(0);
  });

  it("throws on an unknown field name rather than silently dropping it", () => {
    expect(() => encodeMessage(MSG.PhotographyOptions, { not_a_field: 1 })).toThrow(/not_a_field/);
  });

  it("throws on an unknown enum name", () => {
    expect(() => encodeMessage(MSG.PhotographyOptions, { white_balance: "WB_9999K" })).toThrow(
      /WB_9999K/,
    );
  });
});

describe("enum helpers", () => {
  it("maps names to numbers", () => {
    expect(enumValue("insta360.messages.PhotographyOptions.WhiteBalance", "WB_5000K")).toBe(3);
  });

  it("lists names for building UI pickers", () => {
    const names = enumNames("insta360.messages.PhotographyOptions.WhiteBalance");
    expect(names).toContain("WB_AUTO");
    expect(names).toContain("WB_6500K");
  });
});

/**
 * The vendored schema's COLOR_MODE numbering (NORMAL=0, LOG=1, VIVID=2, HDR=3)
 * is not what firmware v1.0.238 uses. Toggling the mode on the camera and
 * diffing `color_mode` before and after (scripts/probe-colorspace.mjs) gave
 * Standard=1, i-Log=2, Dolby Vision=5 — every value shifted, so writing "i-Log"
 * sent 1 and the camera went to Standard, and reading 1 back rendered "i-Log"
 * on a camera that was in Standard. These numbers are measured, not derived.
 */
describe("COLOR_MODE, as firmware v1.0.238 actually numbers it", () => {
  const COLOR_MODE = "insta360.messages.PhotographyOptions.COLOR_MODE";

  it("maps each mode to the number observed on the camera", () => {
    expect(enumValue(COLOR_MODE, "COLOR_MODE_NORMAL")).toBe(1);
    expect(enumValue(COLOR_MODE, "COLOR_MODE_LOG")).toBe(2);
    expect(enumValue(COLOR_MODE, "COLOR_MODE_HDR")).toBe(5);
  });

  it("no longer claims a VIVID mode, which this camera does not have", () => {
    expect(enumValue(COLOR_MODE, "COLOR_MODE_VIVID")).toBeNull();
  });

  it("decodes the camera's idle reading of 1 as Standard, not i-Log", () => {
    // field 35 (tag 0x9802) varint 1 — what a factory-fresh camera reports
    const decoded = decodeMessage(MSG.PhotographyOptions, hex("980201"));
    expect(decoded.color_mode).toBe("COLOR_MODE_NORMAL");
  });

  it("puts Dolby Vision on the wire as 5", () => {
    expect(encodeMessage(MSG.PhotographyOptions, { color_mode: "COLOR_MODE_HDR" })).toEqual(
      hex("980205"),
    );
  });

  it("still encodes Standard, whose number is no longer the proto3 default", () => {
    // The old numbering made Standard 0, so it serialised to nothing and the
    // silent read-back was scored "applied" whether or not anything happened.
    expect(encodeMessage(MSG.PhotographyOptions, { color_mode: "COLOR_MODE_NORMAL" })).toEqual(
      hex("980201"),
    );
    expect(isDefaultValue(MSG.PhotographyOptions, "color_mode", "COLOR_MODE_NORMAL")).toBe(false);
  });
});

describe("isDefaultValue", () => {
  const PO = MSG.PhotographyOptions;

  it("treats a bool false as the default and true as set", () => {
    expect(isDefaultValue(PO, "metering_enable", false)).toBe(true);
    expect(isDefaultValue(PO, "metering_enable", true)).toBe(false);
  });

  it("treats a numeric zero as the default", () => {
    expect(isDefaultValue(PO, "sharpness", 0)).toBe(true);
    expect(isDefaultValue(PO, "sharpness", 3)).toBe(false);
  });

  it("resolves an enum value-name to its number: the zero value is the default", () => {
    // WhiteBalance: WB_AUTO=0, WB_5000K=3
    expect(isDefaultValue(PO, "white_balance", "WB_AUTO")).toBe(true);
    expect(isDefaultValue(PO, "white_balance", "WB_5000K")).toBe(false);
    expect(isDefaultValue(PO, "white_balance", 0)).toBe(true);
  });

  it("treats a nested message value as non-default", () => {
    expect(isDefaultValue(PO, "exposure_manual", { iso: 0 })).toBe(false);
  });

  it("treats an unknown field as non-default rather than guessing", () => {
    expect(isDefaultValue(PO, "not_a_field", 0)).toBe(false);
  });
});

/**
 * The Leica/cinematic filters ride on `gamma_mode`, whose vendored numbering
 * (STANDARD=0, LOG=1, VIVID=2, FLAT=3, then Urban/OceanBlue/Snow/… up to 13)
 * describes a 2020 camera and not this one. Measured on firmware v1.0.238 by
 * stepping the camera through every filter and diffing (probe-colorspace.mjs
 * `series`): the filters land on 15, 16, 24, 26, 34, 35, 36, 37, 38 with 0 for
 * off, and nothing at all on 1-13.
 */
describe("GammaMode, which is really the filter picker", () => {
  const GAMMA = "insta360.messages.GammaMode";

  it("maps each filter to the number measured on the camera", () => {
    expect(enumValue(GAMMA, "FILTER_NONE")).toBe(0);
    expect(enumValue(GAMMA, "FILTER_LEICA_NATURAL")).toBe(15);
    expect(enumValue(GAMMA, "FILTER_LEICA_VIVID")).toBe(16);
    expect(enumValue(GAMMA, "FILTER_NC_FILM")).toBe(24);
    expect(enumValue(GAMMA, "FILTER_CC_FILM")).toBe(26);
    expect(enumValue(GAMMA, "FILTER_POS_FILM")).toBe(34);
    expect(enumValue(GAMMA, "FILTER_NEG_FILM")).toBe(35);
    expect(enumValue(GAMMA, "FILTER_LEICA_CHROME")).toBe(36);
    expect(enumValue(GAMMA, "FILTER_CINEMATIC")).toBe(37);
    expect(enumValue(GAMMA, "FILTER_FRESH")).toBe(38);
  });

  it("drops the 2020 look names, which this camera has no numbers for", () => {
    for (const stale of ["STANDARD", "LOG", "VIVID", "FLAT", "URBAN_1", "SNOW_2"]) {
      expect(enumValue(GAMMA, stale), `${stale} should be gone`).toBeNull();
    }
  });

  it("offers exactly the nine filters the camera has, plus off", () => {
    expect(enumNames(GAMMA)).toHaveLength(10);
  });

  it("puts Leica Vivid on the wire as 16", () => {
    // field 18, tag 0x9001
    expect(encodeMessage(MSG.PhotographyOptions, { gamma_mode: "FILTER_LEICA_VIVID" })).toEqual(
      hex("900110"),
    );
  });
});

/**
 * Filter intensity is a field the vendored schema has no entry for at all —
 * field 104, reachable as option type 104 (this protocol numbers option types
 * to match field numbers, confirmed by asking for type 104 alone and getting
 * field 104 back). Measured Low/Medium/High = 1/2/3 by holding one filter and
 * stepping only its strength.
 */
describe("filter_intensity, a field the extraction never had", () => {
  it("names the three strengths the camera reports", () => {
    const INTENSITY = "insta360.messages.FilterIntensity";
    expect(enumValue(INTENSITY, "INTENSITY_LOW")).toBe(1);
    expect(enumValue(INTENSITY, "INTENSITY_MEDIUM")).toBe(2);
    expect(enumValue(INTENSITY, "INTENSITY_HIGH")).toBe(3);
  });

  it("decodes field 104 as filter_intensity", () => {
    // field 104, tag 0xc006, value 3
    const decoded = decodeMessage(MSG.PhotographyOptions, hex("c00603"));
    expect(decoded.filter_intensity).toBe("INTENSITY_HIGH");
  });

  it("encodes it back to field 104", () => {
    expect(encodeMessage(MSG.PhotographyOptions, { filter_intensity: "INTENSITY_LOW" })).toEqual(
      hex("c00601"),
    );
  });

  it("exposes FILTER_INTENSITY as an option type, so a write can name it", () => {
    expect(enumValue("insta360.messages.PhotographyOptionType", "FILTER_INTENSITY")).toBe(104);
  });
});

/**
 * PhotoSubMode drifted too. Measured on firmware v1.0.238 by switching the
 * capture mode on the camera and reading `photo_sub_mode` back: normal Photo is
 * 0, and Pano is 8 — not the extraction's PHOTO_INSTA_PANO = 5. Writing 5 is
 * why selecting Pano left the camera in ordinary Photo mode.
 */
describe("PhotoSubMode, as this firmware numbers it", () => {
  const SUB = "insta360.messages.PhotoSubMode";

  it("puts Pano on 8, the value the camera actually reports", () => {
    expect(enumValue(SUB, "PHOTO_INSTA_PANO")).toBe(8);
  });

  it("keeps plain Photo on 0", () => {
    expect(enumValue(SUB, "PHOTO_SINGLE")).toBe(0);
  });

  it("keeps the none sentinel, which mode detection tests against", () => {
    expect(enumValue(SUB, "PHOTO_NONE")).toBe(100);
  });

  it("drops the modes this camera does not have", () => {
    for (const gone of ["PHOTO_INSTA_PANO_HDR", "PHOTO_HDR", "PHOTO_STARLAPSE"]) {
      expect(enumValue(SUB, gone), `${gone} should be gone`).toBeNull();
    }
  });
});

/**
 * Photography field 91 is a nested message the extraction has no entry for.
 * Toggling Deep Track on the camera drives its fourth field 2 <-> 5 while the
 * other three hold at 2/2/3, so it tracks the feature.
 *
 * It is NOT a setting. Writing it comes back `differs` — the camera takes the
 * message and reports something else — and the value read on connect did not
 * match what the camera was actually doing. So this is status we cannot yet
 * interpret, and every field here stays a raw number: naming 2 "off" and 5 "on"
 * would assert a direction that has already been wrong once.
 */
describe("deep_track, status rather than a setting", () => {
  it("decodes the nested message without interpreting it", () => {
    // field 91 (tag 0xda05), 8 bytes: {2, 2, 3, 2}
    const decoded = decodeMessage(MSG.PhotographyOptions, hex("da05080802100218032002"));
    expect(decoded.deep_track).toEqual({
      unknown_1: 2,
      unknown_2: 2,
      unknown_3: 3,
      state: 2,
    });
  });

  it("reports the other observed state as its number too", () => {
    const decoded = decodeMessage(MSG.PhotographyOptions, hex("da05080802100218032005"));
    expect((decoded.deep_track as Record<string, unknown>).state).toBe(5);
  });

  it("names no state, so nothing can render 2 or 5 as a claim about tracking", () => {
    expect(enumValue("insta360.messages.DeepTrackState", "TRACK_ON")).toBeNull();
  });

  it("still round-trips, which is what a future read-modify-write would need", () => {
    const bytes = encodeMessage(MSG.PhotographyOptions, {
      deep_track: { unknown_1: 2, unknown_2: 2, unknown_3: 3, state: 5 },
    });
    expect(bytes).toEqual(hex("da05080802100218032005"));
  });
});
