import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../public/demo/fixtures");
const selfPath = fileURLToPath(import.meta.url);
const manifestPath = resolve(outDir, ".fixtures-manifest.json");

/**
 * Fixtures are generated rather than sourced from a stock library: it is
 * reproducible, needs no network, and carries no licence risk. The demo is
 * badged "simulated camera" throughout, so abstract imagery is honest.
 *
 * To swap in real photography later, drop JPEGs into public/demo/fixtures/
 * using these same filenames and skip this script — nothing else needs to change.
 */
const PHOTOS = [
  { name: "IMG_20260718_142012_00_001.jpg", w: 4000, h: 3000, hue: 210 },
  { name: "IMG_20260718_142530_00_002.jpg", w: 4000, h: 3000, hue: 24 },
  { name: "IMG_20260718_150114_00_003.jpg", w: 4000, h: 3000, hue: 145 },
  { name: "IMG_20260718_151902_00_004.jpg", w: 4000, h: 2250, hue: 280 },
  { name: "IMG_20260717_093305_00_005.jpg", w: 4000, h: 3000, hue: 12 },
  { name: "IMG_20260717_094410_00_006.jpg", w: 4000, h: 3000, hue: 190 },
  { name: "IMG_20260717_101207_00_007.jpg", w: 4000, h: 2250, hue: 45 },
  { name: "IMG_20260716_181522_00_008.jpg", w: 4000, h: 3000, hue: 320 },
  { name: "IMG_20260716_182044_00_009.jpg", w: 4000, h: 3000, hue: 95 },
  { name: "IMG_20260716_183310_00_010.jpg", w: 4000, h: 2250, hue: 260 },
];

const VIDEOS = [
  { name: "VID_20260718_143355_00_001.mp4", seconds: 6, hue: 200 },
  { name: "VID_20260717_100210_00_002.mp4", seconds: 4, hue: 30 },
];

const EXPECTED_OUTPUTS = [
  ...PHOTOS.map((p) => p.name),
  ...VIDEOS.map((v) => v.name),
  ...VIDEOS.map((v) => v.name.replace(/^VID_/, "LRV_").replace(/\.mp4$/, ".lrv")),
  "liveview.264",
  "sizes.json",
];

/**
 * Every parameter this script can vary lives in its own source (the PHOTOS/
 * VIDEOS tables above, the filter builders below, the live-view invocation),
 * so hashing the file itself — rather than hand-maintaining a list of "the
 * inputs that matter" — is what a changed parameter can't accidentally slip
 * past. Regeneration is otherwise unconditional (14 fixtures, every run),
 * which measured at 46.6s real / 324s CPU of a 69s `docs:generate` and is
 * paid again on every CI deploy on top of that.
 */
async function scriptHash() {
  const source = await readFile(selfPath, "utf8");
  return createHash("sha256").update(source).digest("hex");
}

/** True only if every expected output already exists and was built from this exact script. */
async function isUpToDate(hash) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return false; // missing or unreadable manifest — no prior run, or a partial one
  }
  if (manifest.hash !== hash) return false;
  for (const name of EXPECTED_OUTPUTS) {
    try {
      await stat(resolve(outDir, name));
    } catch {
      return false; // a partial output directory (e.g. an interrupted prior run)
    }
  }
  return true;
}

/** Gradient + vignette reads as an abstract photograph rather than a test card. */
function photoFilter(w, h, hue) {
  return [
    `color=c=black:s=${w}x${h}`,
    `geq=r='128+100*sin(2*PI*(X/W+${hue / 360}))':g='128+90*sin(2*PI*(Y/H+${hue / 720}))':b='150+80*sin(2*PI*((X+Y)/(W+H)))'`,
    "vignette=PI/4",
    "noise=alls=6:allf=t",
  ].join(",");
}

async function generate() {
  await mkdir(outDir, { recursive: true });

  for (const p of PHOTOS) {
    const out = resolve(outDir, p.name);
    // ffmpeg's lavfi source builds the image entirely in-filter; -frames:v 1
    // takes a single frame out of the synthetic stream.
    await run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      photoFilter(p.w, p.h, p.hue),
      "-frames:v",
      "1",
      "-q:v",
      "4",
      out,
    ]);
  }

  for (const v of VIDEOS) {
    const out = resolve(outDir, v.name);
    await run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=1920x1080:d=${v.seconds}:r=30`,
      "-vf",
      `geq=r='128+100*sin(2*PI*(X/W+T/4+${v.hue / 360}))':g='128+90*sin(2*PI*(Y/H+T/6))':b='150+80*sin(2*PI*((X+Y)/(W+H)-T/8))',vignette=PI/4`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      out,
    ]);
    // The camera pairs each clip with a low-res .lrv proxy; the gallery uses it
    // for thumbnails, and buildMediaItems drops the standalone proxy. Pairing
    // is keyed strictly on `entry.extension === "lrv"` (see lunaIndex.ts), so
    // the proxy needs a real .lrv extension, not just a renamed prefix —
    // ffmpeg can't infer the muxer from that extension, so pass -f mp4.
    await run("ffmpeg", [
      "-y",
      "-i",
      out,
      "-vf",
      "scale=640:-2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-f",
      "mp4",
      resolve(outDir, v.name.replace(/^VID_/, "LRV_").replace(/\.mp4$/, ".lrv")),
    ]);
  }

  // Live-view fixture: a raw H.264 Annex-B elementary stream at the camera's
  // real preview resolution. LiveView.vue's annexb path fetches this and feeds
  // it to WebCodecs, exercising splitNalUnits/drainAccessUnits for real.
  // 12s @ 30fps loops cleanly and keeps the fixture set inside the size
  // budget (30s ran to ~7.2 MB alone, blowing well past ~12 MB total).
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=1280x960:d=12:r=30",
    "-vf",
    "geq=r='120+90*sin(2*PI*(X/W+T/5))':g='120+80*sin(2*PI*(Y/H-T/7))':b='140+70*sin(2*PI*((X-Y)/(W+H)+T/9))',vignette=PI/5,drawtext=text='SIMULATED PREVIEW':fontsize=48:fontcolor=white@0.55:x=(w-text_w)/2:y=h-120",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "baseline",
    "-g",
    "30",
    "-bf",
    "0",
    "-preset",
    "veryfast",
    "-crf",
    "28",
    "-f",
    "h264",
    resolve(outDir, "liveview.264"),
  ]);

  // Record real byte sizes so the mock reports what the gallery actually serves.
  const sizes = {};
  for (const name of [
    ...PHOTOS.map((p) => p.name),
    ...VIDEOS.map((v) => v.name),
    ...VIDEOS.map((v) => v.name.replace(/^VID_/, "LRV_").replace(/\.mp4$/, ".lrv")),
  ]) {
    sizes[name] = (await stat(resolve(outDir, name))).size;
  }
  await writeFile(resolve(outDir, "sizes.json"), JSON.stringify(sizes, null, 2));
  console.log(`generated ${Object.keys(sizes).length} fixtures in ${outDir}`);
}

const hash = await scriptHash();
if (await isUpToDate(hash)) {
  console.log(`fixtures already up to date, skipping regeneration (${outDir})`);
} else {
  await generate();
  // Written only after generate() succeeds, so a run that fails partway
  // leaves no manifest (or a stale one) behind and the next run redoes the
  // whole thing rather than trusting a half-built directory.
  await writeFile(manifestPath, JSON.stringify({ hash }, null, 2));
}
