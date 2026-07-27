import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

/**
 * The desktop app's own icon is the single source of truth for the site's
 * marks. Deriving them at build time rather than committing hand-exported
 * copies means the site can never drift from the app it documents.
 *
 * ffmpeg is already a build prerequisite (it generates the demo fixtures),
 * so this adds no new dependency and works on the CI runner as-is.
 */
const source = resolve(here, "../../../app-icon.png");
const outDir = resolve(here, "../public");

/** The sizes browsers actually request, plus the in-page header mark. */
const SIZES = [
  { name: "favicon-32.png", size: 32 },
  { name: "favicon-64.png", size: 64 },
  { name: "apple-touch-icon.png", size: 180 },
  { name: "icon-192.png", size: 192 },
  { name: "icon-512.png", size: 512 },
];

async function statOrNull(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function generate() {
  const sourceStat = await statOrNull(source);
  if (!sourceStat) throw new Error(`app icon not found at ${source}`);

  await mkdir(outDir, { recursive: true });

  // Skip when every output already exists and post-dates the source. The icon
  // changes roughly never, and a cold ffmpeg pass on every dev-server start is
  // pure waste — same reasoning as the demo fixture cache.
  const freshness = await Promise.all(
    SIZES.map(async ({ name }) => {
      const target = await statOrNull(resolve(outDir, name));
      return target !== null && target.mtimeMs >= sourceStat.mtimeMs;
    }),
  );
  if (freshness.every(Boolean)) {
    console.log(`icons up to date (${SIZES.length} files)`);
    return;
  }

  for (const { name, size } of SIZES) {
    await run("ffmpeg", [
      "-y",
      "-i",
      source,
      "-vf",
      `scale=${size}:${size}:flags=lanczos`,
      resolve(outDir, name),
    ]);
  }

  console.log(`generated ${SIZES.length} icons from app-icon.png`);
}

await generate();
