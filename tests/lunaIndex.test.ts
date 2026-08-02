import { describe, expect, it } from "vitest";
import {
  buildMediaItems,
  entriesFromPaths,
  extractCameraSubdirs,
  parseIndexSize,
  parseLunaIndex,
  parseNameTimestamp,
} from "~/utils/lunaIndex";

const CAMERA_BASE = "http://192.168.42.1/storage_internal/DCIM/Camera01/";

const INDEX_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Luna</title></head>
<body>
<h1>Index of /storage_internal/DCIM/Camera01/</h1>
<pre>
<a href="../">../</a>
<a href="VID_20260718_142530_00_001.mp4">VID_20260718_142530_00_001.mp4</a> 18-Jul-2026 14:25 812M
<a href="LRV_20260718_142530_01_001.lrv">LRV_20260718_142530_01_001.lrv</a> 18-Jul-2026 14:25 48M
<a href="IMG_20260718_142012_00_002.jpg">IMG_20260718_142012_00_002.jpg</a> 18-Jul-2026 14:20 18M
<a href="IMG_20260717_091205_00_003.jpg">IMG_20260717_091205_00_003.jpg</a> 17-Jul-2026 09:12 21M
<a href="LIV_20260716_150000_00_004.jpg">LIV_20260716_150000_00_004.jpg</a> 16-Jul-2026 15:00 16M
<a href="LIV_20260716_150000_00_004.mp4">LIV_20260716_150000_00_004.mp4</a> 16-Jul-2026 15:00 92M
<a href="LRV_20260716_150000_01_004.lrv">LRV_20260716_150000_01_004.lrv</a> 16-Jul-2026 15:00 9M
</pre>
</body>
</html>`;

const ROOT_HTML = `<!doctype html>
<html><body><pre>
<a href="../">../</a>
<a href="Camera01/">Camera01/</a> 20-Jul-2026 10:00 -
<a href="Camera02/">Camera02/</a> 20-Jul-2026 10:00 -
</pre></body></html>`;

describe("parseIndexSize", () => {
  it("parses plain bytes", () => {
    expect(parseIndexSize("512")).toBe(512);
  });

  it("parses K/M/G suffixes", () => {
    expect(parseIndexSize("48M")).toBe(48 * 1024 * 1024);
    expect(parseIndexSize("2G")).toBe(2 * 1024 ** 3);
    expect(parseIndexSize("1.5K")).toBe(Math.floor(1.5 * 1024));
  });

  it("returns null for dashes and junk", () => {
    expect(parseIndexSize("-")).toBeNull();
  });
});

describe("parseNameTimestamp", () => {
  it("parses IMG/VID capture names", () => {
    const date = parseNameTimestamp("IMG_20260718_142012_00_002.jpg");
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(6);
    expect(date?.getDate()).toBe(18);
    expect(date?.getHours()).toBe(14);
    expect(date?.getMinutes()).toBe(20);
    expect(date?.getSeconds()).toBe(12);
  });

  it("returns null for other names", () => {
    expect(parseNameTimestamp("random.jpg")).toBeNull();
  });
});

describe("extractCameraSubdirs", () => {
  it("lists CameraNN directories only", () => {
    expect(extractCameraSubdirs(ROOT_HTML)).toEqual(["Camera01", "Camera02"]);
  });
});

describe("parseLunaIndex", () => {
  const files = parseLunaIndex(INDEX_HTML, CAMERA_BASE);

  it("keeps photos and videos, hides LRV proxies", () => {
    expect(files.map((f) => f.name)).toEqual([
      "VID_20260718_142530_00_001.mp4",
      "IMG_20260718_142012_00_002.jpg",
      "IMG_20260717_091205_00_003.jpg",
      "LIV_20260716_150000_00_004.jpg",
      "LIV_20260716_150000_00_004.mp4",
    ]);
  });

  it("classifies media types", () => {
    expect(files[0]!.type).toBe("video");
    expect(files[1]!.type).toBe("photo");
  });

  it("builds absolute URLs and camera paths", () => {
    expect(files[1]!.srcUrl).toBe(`${CAMERA_BASE}IMG_20260718_142012_00_002.jpg`);
    expect(files[1]!.cameraPath).toBe(
      "/storage_internal/DCIM/Camera01/IMG_20260718_142012_00_002.jpg",
    );
  });

  it("prefers filename timestamps over index columns", () => {
    const taken = new Date(files[1]!.takenAt);
    expect(taken.getSeconds()).toBe(12); // index column has minute precision only
  });

  it("pairs videos with their LRV proxy", () => {
    expect(files[0]!.lrvUrl).toBe(`${CAMERA_BASE}LRV_20260718_142530_01_001.lrv`);
    expect(files[1]!.lrvUrl).toBeUndefined();
  });

  it("pairs live photos and their videos with the LRV proxy", () => {
    const livePhoto = files.find((f) => f.name === "LIV_20260716_150000_00_004.jpg");
    const liveVideo = files.find((f) => f.name === "LIV_20260716_150000_00_004.mp4");
    expect(livePhoto?.lrvUrl).toBe(`${CAMERA_BASE}LRV_20260716_150000_01_004.lrv`);
    expect(liveVideo?.lrvUrl).toBe(`${CAMERA_BASE}LRV_20260716_150000_01_004.lrv`);
  });

  it("parses sizes from the listing", () => {
    expect(files[1]!.size).toBe(18 * 1024 * 1024);
  });
});

describe("RAW+JPEG sibling pairing", () => {
  const html = `<pre>
<a href="IMG_20260707_200510_123.dng">IMG_20260707_200510_123.dng</a> 07-Jul-2026 20:05 71M
<a href="IMG_20260707_200510_123.jpg">IMG_20260707_200510_123.jpg</a> 07-Jul-2026 20:05 8M
<a href="IMG_20260708_090000_124.dng">IMG_20260708_090000_124.dng</a> 08-Jul-2026 09:00 71M
</pre>`;

  it("gives a DNG its sibling JPG as previewUrl", () => {
    const items = parseLunaIndex(html, CAMERA_BASE);
    const dng = items.find((i) => i.name === "IMG_20260707_200510_123.dng")!;
    expect(dng.previewUrl).toBe(`${CAMERA_BASE}IMG_20260707_200510_123.jpg`);
  });

  it("leaves previewUrl unset for a lone DNG and for the JPG itself", () => {
    const items = parseLunaIndex(html, CAMERA_BASE);
    expect(items.find((i) => i.name === "IMG_20260708_090000_124.dng")!.previewUrl).toBeUndefined();
    expect(items.find((i) => i.name === "IMG_20260707_200510_123.jpg")!.previewUrl).toBeUndefined();
  });
});

describe("GET_FILE_LIST path listing (firmware 1.0.238+)", () => {
  // Real filenames from the camera's GET_FILE_LIST response.
  const paths = [
    "/DCIM/Camera01/VID_20260724_182011_137.mp4",
    "/DCIM/Camera01/LRV_20260724_182011_137.lrv",
    "/DCIM/Camera01/IMG_20260724_134210_135.jpg",
    "/DCIM/Camera01/IMG_20260724_134210_135.dng",
  ];
  const items = buildMediaItems(entriesFromPaths(paths, (p) => `http://192.168.42.1${p}`));

  it("drops the .lrv proxy and keeps video + photos", () => {
    expect(items.map((i) => i.name).sort()).toEqual([
      "IMG_20260724_134210_135.dng",
      "IMG_20260724_134210_135.jpg",
      "VID_20260724_182011_137.mp4",
    ]);
  });

  it("pairs the new-format LRV proxy with its video", () => {
    const vid = items.find((i) => i.ext === "mp4")!;
    expect(vid.type).toBe("video");
    expect(vid.lrvUrl).toBe("http://192.168.42.1/DCIM/Camera01/LRV_20260724_182011_137.lrv");
    expect(vid.srcUrl).toBe("http://192.168.42.1/DCIM/Camera01/VID_20260724_182011_137.mp4");
  });

  it("pairs a DNG with its sibling JPG as the preview", () => {
    const dng = items.find((i) => i.ext === "dng")!;
    expect(dng.type).toBe("photo");
    expect(dng.previewUrl).toBe("http://192.168.42.1/DCIM/Camera01/IMG_20260724_134210_135.jpg");
  });

  it("leaves size at 0 for a download to measure and fill in", () => {
    expect(items.every((i) => i.size === 0)).toBe(true);
  });

  it("parses the capture time from the filename", () => {
    const vid = items.find((i) => i.ext === "mp4")!;
    expect(vid.takenAt).toBe(new Date(2026, 6, 24, 18, 20, 11).getTime());
  });
});
