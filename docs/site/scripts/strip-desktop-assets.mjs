import { rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outputPublic = resolve(here, "../.output/public");

// The desktop-app layer's `public/Insta360+LunaUltra.stl` is the official
// hi-fi scan at ~58 MB — most of a 66 MB static site. `scripts/decimate-stl.mjs`
// (run earlier in `dev`/`generate`) writes a <4 MB stand-in to this app's own
// `docs/site/public/Insta360+LunaUltra.stl`, which wins the same-path merge
// (a project's own `public/` takes precedence over an extended layer's), so
// `nuxt generate` should already emit only the small copy.
//
// This is a defensive backstop, not the primary mechanism: if that merge
// precedence ever changes, or the decimation step is skipped/fails silently,
// the huge original could still end up in the output. Only delete a file
// that's actually big enough to be the undecimated original — deleting
// unconditionally here previously stripped the *decimated* file too (it
// matches the same path), leaving the docs site with no model at all.
const MAX_DECIMATED_BYTES = 8 * 1024 * 1024;
const deadAssets = ["Insta360+LunaUltra.stl"];

for (const asset of deadAssets) {
  const target = resolve(outputPublic, asset);
  const size = await stat(target)
    .then((s) => s.size)
    .catch(() => null);

  if (size === null) {
    console.log(`[strip-desktop-assets] ${asset} not present in output, skipping`);
    continue;
  }

  if (size <= MAX_DECIMATED_BYTES) {
    console.log(
      `[strip-desktop-assets] ${asset} is ${(size / 1024 / 1024).toFixed(2)} MB (already decimated), keeping`,
    );
    continue;
  }

  await rm(target);
  console.log(
    `[strip-desktop-assets] removed ${asset} (${(size / 1024 / 1024).toFixed(1)} MB, undecimated original) from .output/public`,
  );
}
