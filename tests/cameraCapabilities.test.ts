import { describe, expect, it } from "vitest";
import {
  colorModesFor,
  filterHasIntensity,
  supportsColorMode,
  supportsFilter,
  supportsPanoAspect,
  resetsToStandard,
} from "~/utils/cameraCapabilities";
import { CAPTURE_MODES } from "~/utils/cameraModes";

describe("supportsColorMode", () => {
  it("offers a colour mode readout in every video mode", () => {
    for (const id of ["video", "pure", "slowmo", "timelapse"]) {
      expect(supportsColorMode(id), `${id} should show colour mode`).toBe(true);
    }
  });

  it("withholds it from Photo and Pano, which have no such picker", () => {
    expect(supportsColorMode("photo")).toBe(false);
    expect(supportsColorMode("pano")).toBe(false);
  });

  it("answers for every capture mode the app can select", () => {
    for (const mode of CAPTURE_MODES) {
      expect(supportsColorMode(mode.id), `no answer for ${mode.id}`).toBeTypeOf("boolean");
    }
  });

  it("treats an unrecognised mode as unsupported rather than guessing", () => {
    expect(supportsColorMode("not-a-mode")).toBe(false);
  });
});

describe("colorModesFor", () => {
  it("offers all three modes in plain video, the only mode that has them", () => {
    expect(colorModesFor("video")).toEqual([
      "COLOR_MODE_NORMAL",
      "COLOR_MODE_LOG",
      "COLOR_MODE_HDR",
    ]);
  });

  it("locks PureVideo, Slow-mo and Timelapse to Standard", () => {
    for (const id of ["pure", "slowmo", "timelapse"]) {
      expect(colorModesFor(id), `${id} should be Standard only`).toEqual(["COLOR_MODE_NORMAL"]);
    }
  });

  it("offers nothing at all where the control does not belong", () => {
    expect(colorModesFor("photo")).toEqual([]);
    expect(colorModesFor("pano")).toEqual([]);
  });

  it("only ever returns modes this firmware actually has", () => {
    const real = new Set(["COLOR_MODE_NORMAL", "COLOR_MODE_LOG", "COLOR_MODE_HDR"]);
    for (const mode of CAPTURE_MODES) {
      for (const value of colorModesFor(mode.id)) {
        expect(real.has(value), `${value} is not a colour mode this camera has`).toBe(true);
      }
    }
  });
});

describe("resetsToStandard", () => {
  it("names the modes that can only shoot Standard with no filter", () => {
    for (const id of ["pano", "pure", "slowmo", "timelapse"]) {
      expect(resetsToStandard(id), `${id} should reset`).toBe(true);
    }
  });

  it("leaves Video and Photo alone, where the choice is the user's", () => {
    expect(resetsToStandard("video")).toBe(false);
    expect(resetsToStandard("photo")).toBe(false);
  });

  it("never claims a mode both offers a choice and is reset away from it", () => {
    for (const mode of CAPTURE_MODES) {
      if (!resetsToStandard(mode.id)) continue;
      const offered = colorModesFor(mode.id);
      expect(offered.length <= 1, `${mode.id} offers ${offered.length} colour modes`).toBe(true);
    }
  });
});

describe("filterHasIntensity", () => {
  it("gives the six cinematic filters a strength control", () => {
    for (const filter of [
      "FILTER_POS_FILM",
      "FILTER_NEG_FILM",
      "FILTER_CC_FILM",
      "FILTER_NC_FILM",
      "FILTER_FRESH",
      "FILTER_CINEMATIC",
    ]) {
      expect(filterHasIntensity(filter), `${filter} should have intensity`).toBe(true);
    }
  });

  it("withholds it from the three Leica profiles, which have no strength", () => {
    expect(filterHasIntensity("FILTER_LEICA_NATURAL")).toBe(false);
    expect(filterHasIntensity("FILTER_LEICA_VIVID")).toBe(false);
    expect(filterHasIntensity("FILTER_LEICA_CHROME")).toBe(false);
  });

  it("withholds it when no filter is applied", () => {
    expect(filterHasIntensity("FILTER_NONE")).toBe(false);
    expect(filterHasIntensity(undefined)).toBe(false);
  });
});

describe("supportsFilter", () => {
  it("allows filters up to 4K60, the manual's cap", () => {
    expect(supportsFilter({ resolution: "RES_3840_2160P60" })).toBe(true);
    expect(supportsFilter({ resolution: "RES_3840_2160P30" })).toBe(true);
    expect(supportsFilter({ resolution: "RES_1920_1080P30" })).toBe(true);
  });

  it("refuses above 4K, where the manual says filters are unavailable", () => {
    expect(supportsFilter({ resolution: "RES_7680_4320P30" })).toBe(false);
    expect(supportsFilter({ resolution: "RES_5312_2988P30" })).toBe(false);
  });

  it("refuses high frame rates", () => {
    expect(supportsFilter({ resolution: "RES_3840_2160P120" })).toBe(false);
    expect(supportsFilter({ resolution: "RES_1920_1080P240" })).toBe(false);
  });

  it("refuses in Dolby Vision, which has no filter picker on the camera", () => {
    expect(supportsFilter({ resolution: "RES_3840_2160P30", colorMode: "COLOR_MODE_HDR" })).toBe(
      false,
    );
  });

  it("allows them in Standard and i-Log", () => {
    expect(supportsFilter({ resolution: "RES_3840_2160P30", colorMode: "COLOR_MODE_NORMAL" })).toBe(
      true,
    );
    expect(supportsFilter({ resolution: "RES_3840_2160P30", colorMode: "COLOR_MODE_LOG" })).toBe(
      true,
    );
  });

  it("stays permissive when the state is unknown or unreadable", () => {
    // Better to offer a control the camera may refuse than to hide one it has
    expect(supportsFilter({})).toBe(true);
    expect(supportsFilter({ resolution: "NOT_A_RESOLUTION" })).toBe(true);
  });
});

describe("supportsPanoAspect", () => {
  it("offers the 360 / 2:1 choice only in Pano", () => {
    expect(supportsPanoAspect("pano")).toBe(true);
  });

  it("withholds it everywhere else, Pano being the only mode with an aspect", () => {
    for (const id of ["photo", "video", "pure", "slowmo", "timelapse"]) {
      expect(supportsPanoAspect(id), `${id} should have no aspect`).toBe(false);
    }
  });
});
