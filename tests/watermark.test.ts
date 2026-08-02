import { describe, expect, it } from "vitest";
import {
  DEFAULT_WATERMARK,
  WATERMARK_ASSET_RATIO,
  WATERMARK_POSITIONS,
  canWatermark,
  nearestAspect,
  watermarkNote,
  watermarkRect,
  watermarkScope,
} from "~/utils/watermark";
import { LUNA_WATERMARK_LAYOUT } from "~/utils/watermarkLayout";
import { makeMediaItem } from "./helpers/media";

describe("nearestAspect", () => {
  it("matches exact aspect ratios", () => {
    expect(nearestAspect(1920, 1080)).toBe("16:9");
    expect(nearestAspect(1080, 1920)).toBe("9:16");
    expect(nearestAspect(1440, 1440)).toBe("1:1");
  });

  it("snaps in-between ratios to the closest configured aspect", () => {
    expect(nearestAspect(1920, 960)).toBe("16:9"); // 2:1 sits closest to 16:9 in log space
    expect(nearestAspect(2350, 1000)).toBe("235:100");
  });
});

describe("watermarkRect", () => {
  it("places the bottom-left watermark using the official 16:9 ratios", () => {
    const rect = watermarkRect(1920, 1080, "bottom-left");
    // Official Leica|16:9|BottomLeft = [0.191, 0.033, 0.059]
    expect(rect.width).toBeCloseTo(1920 * 0.191, 5);
    expect(rect.height).toBeCloseTo(rect.width * WATERMARK_ASSET_RATIO, 5);
    expect(rect.x).toBeCloseTo(1920 * 0.033, 5);
    expect(rect.y + rect.height).toBeCloseTo(1080 - 1080 * 0.059, 5);
  });

  it("mirrors top placements to the top edge", () => {
    const rect = watermarkRect(1920, 1080, "top-left");
    // yRatio 0.88 measured from the bottom puts the mark near the top
    expect(rect.y + rect.height).toBeCloseTo(1080 - 1080 * 0.88, 5);
  });

  it("centers bottom-center horizontally", () => {
    const rect = watermarkRect(1000, 562, "bottom-center");
    // The official table rounds to 3 decimals, so allow sub-percent drift
    expect(Math.abs(rect.x + rect.width / 2 - 500)).toBeLessThan(10);
  });

  it("adapts to portrait aspect tables", () => {
    const rect = watermarkRect(1080, 1920, "bottom-left");
    // Official Leica|9:16|BottomLeft = [0.34, 0.087, 0.033]
    expect(rect.width).toBeCloseTo(1080 * 0.34, 5);
    expect(rect.x).toBeCloseTo(1080 * 0.087, 5);
  });
});

describe("layout table", () => {
  it("exposes the five official positions", () => {
    expect(WATERMARK_POSITIONS).toHaveLength(5);
    for (const positions of Object.values(LUNA_WATERMARK_LAYOUT)) {
      expect(Object.keys(positions).sort()).toEqual([...WATERMARK_POSITIONS].sort());
    }
  });

  it("defaults to the official bottom-left placement", () => {
    expect(DEFAULT_WATERMARK.position).toBe("bottom-left");
    expect(DEFAULT_WATERMARK.enabled).toBe(true);
  });
});

describe("canWatermark", () => {
  it("accepts renderable photos", () => {
    expect(canWatermark(makeMediaItem({ ext: "jpg", renderable: true }))).toBe(true);
  });

  it("rejects RAW photos the canvas pipeline cannot decode", () => {
    const dng = makeMediaItem({ name: "IMG_0001.dng", ext: "dng", renderable: false });
    expect(canWatermark(dng)).toBe(false);
  });

  it("rejects RAW photos even when a sibling JPEG stands in for the preview", () => {
    const dng = makeMediaItem({
      name: "IMG_0001.dng",
      ext: "dng",
      renderable: false,
      previewUrl: "http://127.0.0.1/DCIM/Camera01/IMG_0001.jpg",
    });
    expect(canWatermark(dng)).toBe(false);
  });

  it("rejects videos", () => {
    expect(canWatermark(makeMediaItem({ type: "video", ext: "mp4" }))).toBe(false);
  });
});

describe("watermarkScope", () => {
  it("splits a mixed selection into watermarkable photos, raw photos and videos", () => {
    const jpeg = makeMediaItem({ id: "jpg", name: "IMG_0001.jpg" });
    const raw = makeMediaItem({ id: "dng", name: "IMG_0001.dng", ext: "dng", renderable: false });
    const video = makeMediaItem({ id: "mp4", name: "VID_0001.mp4", type: "video", ext: "mp4" });

    const scope = watermarkScope([jpeg, raw, video]);

    expect(scope.watermarkable).toEqual([jpeg]);
    expect(scope.raw).toEqual([raw]);
    expect(scope.videos).toEqual([video]);
  });

  it("reports an empty scope for an empty selection", () => {
    expect(watermarkScope([])).toEqual({ watermarkable: [], raw: [], videos: [] });
  });
});

describe("watermarkNote", () => {
  const jpeg = makeMediaItem({ id: "jpg", name: "IMG_0001.jpg" });
  const raw = makeMediaItem({ id: "dng", name: "IMG_0001.dng", ext: "dng", renderable: false });
  const video = makeMediaItem({ id: "mp4", name: "VID_0001.mp4", type: "video", ext: "mp4" });

  it("promises the watermark without qualification when every photo is renderable", () => {
    expect(watermarkNote(watermarkScope([jpeg]))).toBe("Watermark will be applied to photos.");
  });

  it("says RAW is left alone when the selection mixes JPEG and RAW", () => {
    expect(watermarkNote(watermarkScope([jpeg, raw]))).toBe(
      "Watermark will be applied to JPEG photos; RAW files are saved unmodified.",
    );
  });

  it("promises nothing when the selection is RAW only", () => {
    const note = watermarkNote(watermarkScope([raw]));
    expect(note).toBe("RAW files are saved unmodified; watermarking applies to JPEG photos only.");
    expect(note).not.toMatch(/will be applied/);
  });

  it("promises nothing when the selection is videos only", () => {
    expect(watermarkNote(watermarkScope([video]))).toBe(
      "Videos transfer untouched; watermarking applies to JPEG photos only.",
    );
  });
});
