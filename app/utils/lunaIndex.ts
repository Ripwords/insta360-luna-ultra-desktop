import type { MediaItem, MediaStorage } from "~/types/media";

/** Photo formats the browser can render directly (insp is JPEG-based). */
const RENDERABLE_IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "insp"]);

/**
 * Parser for the Luna Ultra's HTTP media index (autoindex-style HTML pages),
 * ported from luna-ai-cut's electron/lunaMediaIndex.ts. The camera serves
 * storage roots (e.g. /storage_internal/DCIM/) containing CameraNN
 * directories whose listings link every media file with a date, time and
 * size column.
 */
const INDEX_RE =
  /<a href="(?<href>[^"]+)">(?<name>[^<]+)<\/a>\s+(?<date>\d{2}-[A-Za-z]{3}-\d{4})\s+(?<time>\d{2}:\d{2})\s+(?<size>\S+)/gi;

const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "dng", "insp", "webp"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov"]);

function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

export function parseIndexSize(text: string): number | null {
  const match = text.trim().match(/^(?<number>\d+(?:\.\d+)?)(?<unit>[KMG])?$/i);
  if (!match?.groups) return null;
  const value = Number.parseFloat(match.groups.number!);
  const unit = match.groups.unit?.toUpperCase();
  const multiplier = unit === "G" ? 1024 ** 3 : unit === "M" ? 1024 ** 2 : unit === "K" ? 1024 : 1;
  return Math.floor(value * multiplier);
}

/** Capture timestamp encoded in names like IMG_20260718_142012_00_002.jpg */
export function parseNameTimestamp(name: string): Date | null {
  const match = name.match(
    /(?:VID|LRV|IMG|LIV|PIC|PANO)_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/i,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
}

function parseIndexTimestamp(dateText: string, timeText: string): Date | null {
  const dateMatch = dateText.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  const timeMatch = timeText.match(/^(\d{2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) return null;
  const month = MONTHS[dateMatch[2]!];
  if (month === undefined) return null;
  return new Date(
    Number(dateMatch[3]),
    month,
    Number(dateMatch[1]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    0,
  );
}

/** CameraNN subdirectories linked from a storage root index page */
export function extractCameraSubdirs(html: string): string[] {
  const dirs: string[] = [];
  for (const match of html.matchAll(INDEX_RE)) {
    const href = match.groups?.href;
    if (!href) continue;
    const decoded = htmlDecode(href);
    if (decoded !== "../" && decoded.endsWith("/") && /^Camera\d+\/$/i.test(decoded)) {
      dirs.push(decoded.replace(/\/$/, ""));
    }
  }
  return dirs.sort();
}

/**
 * Pairing key linking a full-res video with its .lrv proxy. Handles the old
 * name shape (VID_<date>_<time>_<NN>_<clip>) and firmware 1.0.238's, which
 * dropped the substream segment (VID_<date>_<time>_<clip>).
 */
function proxyKey(name: string): string | null {
  const legacy = name.match(/^(?:VID|LRV|LIV)_(\d{8}_\d{6})_\d{2}_(\d+)\.\w+$/i);
  if (legacy) return `${legacy[1]}_${legacy[2]}`;
  const next = name.match(/^(?:VID|LRV|LIV)_(.+)\.\w+$/i);
  return next?.[1] ?? null;
}

export interface RawEntry {
  name: string;
  url: string;
  cameraPath: string;
  extension: string;
  takenAt: number;
  size: number;
}

/**
 * Assemble MediaItems from raw file entries: pair .lrv video proxies and
 * DNG+JPG siblings, flag 360 panos, drop the standalone proxies, and dedupe.
 * Shared by the HTTP-index parser and the GET_FILE_LIST path.
 */
export function buildMediaItems(
  entries: RawEntry[],
  storage: MediaStorage = "internal",
): MediaItem[] {
  const lrvByKey = new Map<string, RawEntry>();
  for (const entry of entries) {
    if (entry.extension !== "lrv") continue;
    const key = proxyKey(entry.name);
    if (key) lrvByKey.set(key, entry);
  }

  // RAW+JPEG pairs: the camera saves IMG_x.dng alongside IMG_x.jpg. The JPG is
  // the same shot, so it serves as the DNG's renderable grid thumbnail.
  const jpgByBase = new Map<string, RawEntry>();
  for (const entry of entries) {
    if (entry.extension !== "jpg" && entry.extension !== "jpeg") continue;
    jpgByBase.set(entry.name.slice(0, entry.name.lastIndexOf(".")), entry);
  }

  const items: MediaItem[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.extension === "lrv") continue;
    if (seen.has(entry.cameraPath)) continue;
    seen.add(entry.cameraPath);
    const isVideo = VIDEO_EXTENSIONS.has(entry.extension);
    const key = proxyKey(entry.name);
    const lrv = key ? lrvByKey.get(key) : undefined;
    const siblingJpg =
      entry.extension === "dng"
        ? jpgByBase.get(entry.name.slice(0, entry.name.lastIndexOf(".")))
        : undefined;
    // PANO_ shots and Insta360 .insp files are equirectangular 360 photos
    const panoramic = !isVideo && (/^PANO_/i.test(entry.name) || entry.extension === "insp");
    items.push({
      id: entry.cameraPath,
      name: entry.name,
      type: isVideo ? "video" : "photo",
      storage,
      ext: entry.extension,
      renderable: isVideo || RENDERABLE_IMAGE_EXTENSIONS.has(entry.extension),
      panoramic,
      takenAt: entry.takenAt,
      size: entry.size,
      cameraPath: entry.cameraPath,
      srcUrl: entry.url,
      lrvUrl: lrv?.url,
      previewUrl: siblingJpg?.url,
    });
  }
  return items;
}

/**
 * Build raw entries from GET_FILE_LIST paths. Firmware 1.0.238+ disabled the
 * HTTP directory autoindex, so files are enumerated over the control session
 * instead; each file stays fetchable by its URL while the session is held.
 * Size isn't reported here — it's resolved lazily when a file is downloaded.
 */
export function entriesFromPaths(paths: string[], urlFor: (path: string) => string): RawEntry[] {
  const entries: RawEntry[] = [];
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (name.toLowerCase().endsWith(".live.mp4")) continue;
    const extension = extensionOf(name);
    if (!IMAGE_EXTENSIONS.has(extension) && !VIDEO_EXTENSIONS.has(extension) && extension !== "lrv")
      continue;
    entries.push({
      name,
      url: urlFor(path),
      cameraPath: path,
      extension,
      takenAt: (parseNameTimestamp(name) ?? new Date(0)).getTime(),
      size: 0,
    });
  }
  return entries;
}

export function parseLunaIndex(
  html: string,
  baseUrl: string,
  storage: MediaStorage = "internal",
): MediaItem[] {
  const entries: RawEntry[] = [];
  for (const match of html.matchAll(INDEX_RE)) {
    const groups = match.groups;
    if (!groups) continue;
    const href = htmlDecode(groups.href!);
    const name = htmlDecode(groups.name!);
    if (href === "../" || name === "../" || href.endsWith("/")) continue;
    if (name.toLowerCase().endsWith(".live.mp4")) continue;
    const extension = extensionOf(name);
    if (!IMAGE_EXTENSIONS.has(extension) && !VIDEO_EXTENSIONS.has(extension) && extension !== "lrv")
      continue;
    const url = new URL(href, baseUrl);
    const timestamp = parseNameTimestamp(name) ?? parseIndexTimestamp(groups.date!, groups.time!);
    entries.push({
      name,
      url: url.toString(),
      cameraPath: decodeURIComponent(url.pathname),
      extension,
      takenAt: (timestamp ?? new Date(0)).getTime(),
      size: parseIndexSize(groups.size!) ?? 0,
    });
  }
  return buildMediaItems(entries, storage);
}
