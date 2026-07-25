import { describe, expect, it } from "vitest";
import {
  ISO_STEPS,
  isoLabel,
  optionLabel,
  shutterLabel,
  shutterNameForSeconds,
  shutterSeconds,
  shutterSteps,
  visibleEnumNames,
  zoomForFraction,
  zoomFraction,
  resolutionLabel,
  resolutionParts,
  composeResolution,
  zoomLabel,
} from "~/utils/cameraLabels";

describe("shutterLabel", () => {
  it("renders fractions, where D means divide", () => {
    expect(shutterLabel("SPEED_1D8000")).toBe("1/8000");
    expect(shutterLabel("SPEED_1D60")).toBe("1/60");
    expect(shutterLabel("SPEED_1D2")).toBe("1/2");
  });

  it("renders whole seconds with a unit", () => {
    expect(shutterLabel("SPEED_60")).toBe("60s");
    expect(shutterLabel("SPEED_1")).toBe("1s");
  });

  it("renders decimals, where P is the decimal point", () => {
    expect(shutterLabel("SPEED_1P6")).toBe("1.6s");
    expect(shutterLabel("SPEED_1P3")).toBe("1.3s");
  });

  it("handles fractions with a decimal denominator", () => {
    expect(shutterLabel("SPEED_1D1P25")).toBe("1/1.25");
    expect(shutterLabel("SPEED_1D12P5")).toBe("1/12.5");
  });

  it("names auto plainly", () => {
    expect(shutterLabel("SPEED_AUTO")).toBe("Auto");
  });

  it("passes through anything it does not recognise", () => {
    expect(shutterLabel("SPEED_FUTURE_VALUE")).toBe("SPEED_FUTURE_VALUE");
    expect(shutterLabel("")).toBe("");
  });

  it("tolerates the trailing marker seen on SPEED_1D8P", () => {
    expect(shutterLabel("SPEED_1D8P")).toBe("1/8");
  });
});

describe("shutterSteps", () => {
  it("runs from Auto through to the fastest speed", () => {
    const steps = shutterSteps();
    expect(steps[0]).toEqual({ value: "SPEED_AUTO", label: "Auto" });
    expect(steps.at(-1)).toEqual({ value: "SPEED_1D8000", label: "1/8000" });
  });

  it("covers every value the camera defines", () => {
    expect(shutterSteps()).toHaveLength(49);
  });
});

describe("isoLabel", () => {
  it("shows zero as auto, because that is what the camera means by it", () => {
    expect(isoLabel(0)).toBe("Auto");
  });

  it("shows other values verbatim", () => {
    expect(isoLabel(400)).toBe("400");
  });
});

describe("ISO_STEPS", () => {
  it("starts at auto and climbs in stops", () => {
    expect(ISO_STEPS[0]).toBe(0);
    expect(ISO_STEPS).toContain(100);
    expect(ISO_STEPS).toContain(6400);
  });
});

describe("shutterSeconds", () => {
  it("converts fractions and decimals to seconds", () => {
    expect(shutterSeconds("SPEED_1D120")).toBeCloseTo(1 / 120, 6);
    expect(shutterSeconds("SPEED_1D8000")).toBeCloseTo(1 / 8000, 8);
    expect(shutterSeconds("SPEED_1P3")).toBe(1.3);
    expect(shutterSeconds("SPEED_5")).toBe(5);
  });

  it("treats auto and junk as 0", () => {
    expect(shutterSeconds("SPEED_AUTO")).toBe(0);
    expect(shutterSeconds("nonsense")).toBe(0);
  });
});

describe("shutterNameForSeconds", () => {
  it("maps 0 seconds back to Auto", () => {
    expect(shutterNameForSeconds(0)).toBe("SPEED_AUTO");
  });

  it("round-trips a real shutter value through seconds and back", () => {
    for (const name of ["SPEED_1D120", "SPEED_1D8000", "SPEED_1P3"]) {
      expect(shutterNameForSeconds(shutterSeconds(name))).toBe(name);
    }
  });
});

describe("optionLabel", () => {
  it("names color modes the way the camera does", () => {
    expect(optionLabel("COLOR_MODE_NORMAL")).toBe("Standard");
    expect(optionLabel("COLOR_MODE_LOG")).toBe("i-Log");
    expect(optionLabel("COLOR_MODE_HDR")).toBe("Dolby Vision");
  });

  it("labels white balance presets cleanly", () => {
    expect(optionLabel("WB_AUTO")).toBe("Auto");
    expect(optionLabel("WB_5000K")).toBe("5000K");
  });

  it("tidies unlisted enum values instead of failing", () => {
    expect(optionLabel("FOV_WIDE")).toBe("FOV WIDE");
  });
});

describe("visibleEnumNames", () => {
  it("offers exactly the three colour modes this camera has", () => {
    const modes = visibleEnumNames("insta360.messages.PhotographyOptions.COLOR_MODE");
    expect(modes).toEqual(["COLOR_MODE_NORMAL", "COLOR_MODE_LOG", "COLOR_MODE_HDR"]);
  });

  /**
   * This used to assert that gamma_mode's Urban/Ocean Blue/Snow/… entries were
   * hidden while STANDARD/LOG/VIVID/FLAT were kept as "the real curves". Both
   * halves were wrong: gamma_mode is the Filter picker, and none of those six
   * names exists on this camera. The firmware-corrected enum has no phantoms
   * left to hide, so nothing needs filtering out.
   */
  it("passes the filter list through, there being no phantoms left to hide", () => {
    const filters = visibleEnumNames("insta360.messages.GammaMode");
    expect(filters).toContain("FILTER_LEICA_VIVID");
    expect(filters).toContain("FILTER_FRESH");
    for (const phantom of ["STANDARD", "VIVID", "FLAT", "URBAN_1", "NIGHTLIGHT_2"]) {
      expect(filters).not.toContain(phantom);
    }
  });
});

describe("zoom", () => {
  it("labels each stop the way a lens is marked", () => {
    expect(zoomLabel(1)).toBe("1x");
    expect(zoomLabel(1.5)).toBe("1.5x");
    expect(zoomLabel(12)).toBe("12x");
  });

  it("shows one decimal while dragging, and drops it when whole", () => {
    expect(zoomLabel(4.86)).toBe("4.9x");
    expect(zoomLabel(2.04)).toBe("2x");
  });

  it("anchors the ends of the dial at 1x and 12x", () => {
    expect(zoomForFraction(0)).toBe(1);
    expect(zoomForFraction(1)).toBe(12);
  });

  it("clamps a drag that runs past either end", () => {
    expect(zoomForFraction(-0.4)).toBe(1);
    expect(zoomForFraction(1.7)).toBe(12);
  });

  /**
   * Logarithmic, not linear: a lens barrel gives the wide end more travel
   * because a step from 1x to 2x reframes far more than 11x to 12x. Linear
   * would make the useful range a sliver at the bottom of the dial.
   */
  it("gives the wide end more of the dial than the long end", () => {
    const wide = zoomFraction(2) - zoomFraction(1);
    const long = zoomFraction(12) - zoomFraction(11);
    expect(wide).toBeGreaterThan(long * 5);
  });

  it("puts the geometric middle at the dial's midpoint", () => {
    expect(zoomForFraction(0.5)).toBeCloseTo(Math.sqrt(12), 1);
  });

  /**
   * Zoom -> position -> zoom, not the reverse. Positions do not round-trip
   * exactly because zoomForFraction rounds to the 0.1 the label shows, and at
   * the wide end 0.1x is a visible slice of the dial. Rounding is the point, so
   * the test asserts the direction that has to be exact: a zoom the dial can
   * actually display survives the trip unchanged.
   */
  it("round-trips a displayable zoom through its position and back", () => {
    for (const scale of [1, 1.4, 2, 3.5, 6, 9.1, 12]) {
      expect(zoomForFraction(zoomFraction(scale))).toBeCloseTo(scale, 1);
    }
  });
});

describe("resolutionLabel", () => {
  it("names the family the way the camera does, not the pixel count", () => {
    expect(resolutionLabel("RES_7680_4320P30")).toBe("8K 30");
    expect(resolutionLabel("RES_3840_2160P120")).toBe("4K 120");
    expect(resolutionLabel("RES_1920_1080P24")).toBe("1080p 24");
  });

  it("marks the aspect where it is not the usual 16:9", () => {
    expect(resolutionLabel("RES_3072_3072P30")).toBe("3K 1:1 30");
    expect(resolutionLabel("RES_1080_1920P60")).toBe("1080p 9:16 60");
  });

  it("falls back to the raw dimensions for a family it does not know", () => {
    expect(resolutionLabel("RES_1234_567P30")).toBe("1234×567 30");
  });

  it("passes anything unparseable through rather than inventing a name", () => {
    expect(resolutionLabel("NOT_A_RESOLUTION")).toBe("NOT_A_RESOLUTION");
  });
});

describe("resolutionParts", () => {
  it("splits a resolution into the three things you actually pick", () => {
    expect(resolutionParts("RES_3840_2160P120")).toEqual({
      size: "4K",
      aspect: "16:9",
      fps: 120,
    });
    expect(resolutionParts("RES_3840_1632P50")).toEqual({
      size: "4K",
      aspect: "2.35:1",
      fps: 50,
    });
    expect(resolutionParts("RES_3072_3072P60")).toEqual({ size: "3K", aspect: "1:1", fps: 60 });
    expect(resolutionParts("RES_2688_1520P24")).toEqual({ size: "2.7K", aspect: "16:9", fps: 24 });
  });

  it("returns nothing for a name it cannot read, rather than a guess", () => {
    expect(resolutionParts("NOT_A_RESOLUTION")).toBeNull();
  });

  it("round-trips through the composed name", () => {
    for (const name of ["RES_7680_4320P30", "RES_1920_1080P240", "RES_3840_1632P48"]) {
      const parts = resolutionParts(name)!;
      expect(composeResolution(parts.size, parts.aspect, parts.fps)).toBe(name);
    }
  });

  it("composes nothing for a combination the camera has no frame size for", () => {
    expect(composeResolution("8K", "1:1", 30)).toBeNull();
  });
});
