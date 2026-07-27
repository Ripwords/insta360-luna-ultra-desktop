import sizes from "../../public/demo/fixtures/sizes.json";

/**
 * Camera-style absolute paths. The mock hands these to the app's real
 * `entriesFromPaths`/`buildMediaItems`, so the demo exercises the actual
 * index parser rather than constructing MediaItems directly.
 */
export const FIXTURE_PATHS: string[] = Object.keys(sizes)
  .map((name) => `/storage_internal/DCIM/Camera01/${name}`)
  .sort();

export const FIXTURE_SIZES: Record<string, number> = sizes;

/** Resolve a camera path to a real URL, honouring the deployed base path. */
export function fixtureUrl(cameraPath: string): string {
  const name = cameraPath.slice(cameraPath.lastIndexOf("/") + 1);
  return `${useRuntimeConfig().app.baseURL}demo/fixtures/${name}`;
}
