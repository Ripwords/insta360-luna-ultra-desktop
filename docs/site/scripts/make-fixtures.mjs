import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../public/demo/fixtures");

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
    // for thumbnails, and buildMediaItems drops the standalone proxy.
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
      resolve(outDir, v.name.replace(/^VID_/, "LRV_")),
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
    ...VIDEOS.map((v) => v.name.replace(/^VID_/, "LRV_")),
  ]) {
    sizes[name] = (await stat(resolve(outDir, name))).size;
  }
  await writeFile(resolve(outDir, "sizes.json"), JSON.stringify(sizes, null, 2));
  console.log(`generated ${Object.keys(sizes).length} fixtures in ${outDir}`);
}

await generate();
