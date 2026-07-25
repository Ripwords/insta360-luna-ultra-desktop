import { describe, expect, it } from "vitest";
import {
  colorModesFor,
  filterHasIntensity,
  supportsColorMode,
  supportsFilter,
  supportsPanoAspect,
  resetsToStandard,
  resolutionsFor,
  sizesFor,
  aspectsFor,
  fpsFor,
  MEASURED_RESOLUTIONS,
} from "~/utils/cameraCapabilities";
import { CAPTURE_MODES } from "~/utils/cameraModes";
import { composeResolution } from "~/utils/cameraLabels";

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

describe("resolutionsFor", () => {
  it("offers the video list, which is the one fully measured", () => {
    const list = resolutionsFor("video");
    expect(list).toContain("RES_7680_4320P30");
    expect(list).toContain("RES_3840_2160P120");
    expect(list).toContain("RES_1920_1080P240");
  });

  it("caps PureVideo at 60fps, as the manual does", () => {
    const list = resolutionsFor("pure");
    expect(list).toContain("RES_3840_2160P30");
    expect(list).not.toContain("RES_3840_2160P120");
    expect(list).not.toContain("RES_1920_1080P240");
  });

  /**
   * Framerate alone is not enough of a filter. 8K tops out at 30fps, so a
   * fps-only rule let it through into PureVideo and Timelapse, neither of which
   * the manual says shoots 8K at all.
   */
  it("keeps 8K out of the modes that cannot shoot it", () => {
    for (const mode of ["pure", "slowmo", "timelapse"]) {
      expect(
        resolutionsFor(mode).some((r) => r.startsWith("RES_7680_")),
        `${mode} should not offer 8K`,
      ).toBe(false);
    }
  });

  it("keeps the 1:1 crop to Video, the only mode the manual lists it for", () => {
    expect(resolutionsFor("video")).toContain("RES_3072_3072P60");
    expect(resolutionsFor("pure")).not.toContain("RES_3072_3072P60");
  });

  it("offers Slow-mo only the high frame rates", () => {
    const list = resolutionsFor("slowmo");
    expect(list).toContain("RES_1920_1080P240");
    expect(list).toContain("RES_3840_2160P120");
    expect(list).not.toContain("RES_3840_2160P30");
  });

  it("offers Timelapse 30fps only", () => {
    expect(resolutionsFor("timelapse").every((r) => r.endsWith("P30"))).toBe(true);
  });

  it("offers nothing for stills modes, which use a photo size instead", () => {
    expect(resolutionsFor("photo")).toEqual([]);
    expect(resolutionsFor("pano")).toEqual([]);
  });

  /**
   * The guard that matters: the camera uses 258 for a resolution the schema
   * calls RES_3840_2160P25 = 48, so entries we have not seen on the wire cannot
   * be trusted. Every value offered must have been measured.
   */
  it("only ever offers resolutions measured on the camera", () => {
    for (const mode of CAPTURE_MODES) {
      for (const value of resolutionsFor(mode.id)) {
        expect(MEASURED_RESOLUTIONS.includes(value), `${value} was never measured`).toBe(true);
      }
    }
  });
});

describe("resolution pickers", () => {
  it("offers the frame sizes this mode has, largest first", () => {
    expect(sizesFor("video")).toEqual(["8K", "4K", "3K", "2.7K", "1080p"]);
    expect(sizesFor("slowmo")).toEqual(["4K", "2.7K", "1080p"]);
  });

  it("offers only the aspects that frame size actually has", () => {
    expect(aspectsFor("video", "4K")).toEqual(["16:9", "2.35:1"]);
    expect(aspectsFor("video", "8K")).toEqual(["16:9"]);
    expect(aspectsFor("video", "3K")).toEqual(["1:1"]);
  });

  it("offers only the framerates that size and aspect actually have", () => {
    expect(fpsFor("video", "8K", "16:9")).toEqual([30, 25, 24]);
    expect(fpsFor("slowmo", "1080p", "16:9")).toEqual([240, 200, 120, 100]);
    expect(fpsFor("timelapse", "4K", "16:9")).toEqual([30]);
  });

  /**
   * Picking a size must not strand you on a combination that does not exist —
   * 8K has no 120fps, so coming from 4K120 has to land somewhere real.
   */
  it("never offers a combination the camera does not have", () => {
    for (const mode of CAPTURE_MODES) {
      for (const size of sizesFor(mode.id)) {
        for (const aspect of aspectsFor(mode.id, size)) {
          const rates = fpsFor(mode.id, size, aspect);
          expect(rates.length, `${mode.id} ${size} ${aspect} has no framerates`).toBeGreaterThan(0);
          for (const fps of rates) {
            expect(resolutionsFor(mode.id)).toContain(composeResolution(size, aspect, fps));
          }
        }
      }
    }
  });

  it("gives nothing for a mode with no resolutions at all", () => {
    expect(sizesFor("photo")).toEqual([]);
    expect(aspectsFor("photo", "4K")).toEqual([]);
  });
});
