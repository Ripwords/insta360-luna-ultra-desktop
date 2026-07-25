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
