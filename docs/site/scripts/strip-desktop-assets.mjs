import { rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outputPublic = resolve(here, "../.output/public");

// `LunaModel.vue` (inherited from the desktop-app layer's `/demo/*` pages)
// requests this file at a root-absolute `/Insta360+LunaUltra.stl`, which
// 404s under this site's `/insta360-luna-ultra-desktop/` base path — the 3D
// view already falls back to its procedural placeholder mesh, so the file
// never actually loads for a visitor. `nuxt generate` still copies it into
// the output because it lives in the layer's `public/` (correctly, since it
// IS load-bearing for the real desktop app), and Nuxt merges every layer's
// `public/` verbatim. At ~59 MB it's most of a 66 MB static site, so delete
// the dead copy from the generated artifact post-build rather than editing
// the desktop app's `public/` (which would break the real app).
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

  await rm(target);
  console.log(
    `[strip-desktop-assets] removed ${asset} (${(size / 1024 / 1024).toFixed(1)} MB) from .output/public`,
  );
}
