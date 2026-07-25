/**
 * Feature flags for work that isn't ready to ship.
 *
 * Each flag defaults to `import.meta.dev`, so in-development features stay
 * visible while running `nuxt dev` / `tauri dev` but are hidden in the packaged
 * release build (`tauri build` → `nuxt generate`, where `import.meta.dev` is
 * false). Hard-code a flag to `true`/`false` to force it in any build.
 */
export const FEATURES = {
  /**
   * Capture modes beyond Video and Photo (Pure, Slow-mo, Pano, Pano HDR,
   * Timelapse). Kept back until each is verified on-device.
   */
  extraCaptureModes: true,

  /**
   * The Color Mode picker (Standard / i-Log / Dolby Vision). `color_mode` was
   * the right lever all along; what was wrong was its numbering, which firmware
   * v1.0.238 shifted away from the vendored schema (see the COLOR_MODE override
   * in scripts/build-schema.mjs).
   */
  colorMode: true,

  /**
   * The full settings panel — every option the camera acknowledges, reachable
   * from MORE in the pro bar and the sliders button in the header.
   *
   * Off. Most of those controls have never been exercised on-device, and the
   * two that were checked properly (colour mode, filters) both turned out to be
   * writing wrong values against a stale schema while reporting success. Until
   * each one is verified the same way, a panel of confident-looking controls
   * that quietly do the wrong thing is worse than no panel.
   *
   * Both entry points are gated together — leaving one open would defeat it.
   */
  allSettings: false,
} as const;
