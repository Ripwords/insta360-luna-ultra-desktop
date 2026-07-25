import { describe, expect, it } from "vitest";
import { CAPTURE_MODES, findMode, isPhotoMode, modeForState } from "~/utils/cameraModes";

describe("CAPTURE_MODES", () => {
  it("covers the modes the camera exposes on its own dial", () => {
    expect(CAPTURE_MODES.map((m) => m.id)).toEqual([
      "video",
      "pure",
      "slowmo",
      "photo",
      "pano",
      "timelapse",
    ]);
  });

  it("routes video modes through VIDEO_SUB_MODE and photo modes through PHOTO_SUB_MODE", () => {
    expect(findMode("video")!.optionType).toBe("VIDEO_SUB_MODE");
    expect(findMode("pure")!.optionType).toBe("VIDEO_SUB_MODE");
    expect(findMode("slowmo")!.optionType).toBe("VIDEO_SUB_MODE");
    expect(findMode("photo")!.optionType).toBe("PHOTO_SUB_MODE");
    expect(findMode("pano")!.optionType).toBe("PHOTO_SUB_MODE");
  });

  it("uses the sub-mode values the camera defines", () => {
    expect(findMode("pure")!.subMode).toBe("VIDEO_PURE");
    expect(findMode("slowmo")!.subMode).toBe("VIDEO_SLOW_MOTION");
    expect(findMode("pano")!.subMode).toBe("PHOTO_INSTA_PANO");
    expect(findMode("photo")!.subMode).toBe("PHOTO_SINGLE");
  });

  it("pairs each mode with the function mode its settings live under", () => {
    expect(findMode("video")!.functionMode).toBe("FUNCTION_MODE_NORMAL_VIDEO");
    expect(findMode("slowmo")!.functionMode).toBe("FUNCTION_MODE_SLOWMOTION_VIDEO");
    expect(findMode("photo")!.functionMode).toBe("FUNCTION_MODE_NORMAL_IMAGE");
    expect(findMode("pano")!.functionMode).toBe("FUNCTION_MODE_NORMAL_POWER_PANO_IMAGE");
  });

  it("has no Pano HDR, which this camera does not offer", () => {
    expect(findMode("panoHdr")).toBeUndefined();
    expect(CAPTURE_MODES.some((m) => m.subMode === "PHOTO_INSTA_PANO_HDR")).toBe(false);
  });

  it("gives stills modes a shutter rather than a record button", () => {
    expect(isPhotoMode("photo")).toBe(true);
    expect(isPhotoMode("pano")).toBe(true);
    expect(isPhotoMode("video")).toBe(false);
    expect(isPhotoMode("pure")).toBe(false);
  });

  it("names a capture mode for every video mode that starts a recording", () => {
    expect(findMode("video")!.captureMode).toBe("Capture_MODE_NORMAL");
    expect(findMode("pure")!.captureMode).toBe("Capture_MODE_PURE_VIDEO");
    expect(findMode("slowmo")!.captureMode).toBe("Capture_MODE_SLOWMOTION");
  });
});

describe("findMode", () => {
  it("returns undefined for an unknown id", () => {
    expect(findMode("nonsense")).toBeUndefined();
  });
});

describe("modeForState", () => {
  it("prefers the video sub-mode when one is active", () => {
    expect(modeForState("VIDEO_PURE", "PHOTO_NONE")?.id).toBe("pure");
    expect(modeForState("VIDEO_SLOW_MOTION", "PHOTO_NONE")?.id).toBe("slowmo");
  });

  it("falls back to the photo sub-mode when video reports none", () => {
    expect(modeForState("VIDEO_NONE", "PHOTO_INSTA_PANO")?.id).toBe("pano");
    expect(modeForState("VIDEO_NONE", "PHOTO_SINGLE")?.id).toBe("photo");
  });

  it("returns null when neither sub-mode is recognised", () => {
    // The camera reported photo_sub_mode 8, which postdates the schema
    expect(modeForState("VIDEO_NONE", "8")).toBeNull();
    expect(modeForState(undefined, undefined)).toBeNull();
  });
});
