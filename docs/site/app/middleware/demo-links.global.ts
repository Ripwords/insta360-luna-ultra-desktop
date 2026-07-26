const APP_PATHS = new Set(["/", "/camera", "/gallery", "/downloads", "/settings"]);

/**
 * The demo runs the desktop app's real pages, which hardcode root-level links
 * (`to="/gallery"`, `to="/"`) because that is correct in the desktop app. Under
 * the docs site those routes live at /demo/*. Rewriting here — rather than in
 * the app — keeps the desktop app untouched.
 *
 * Scoped to navigations that START inside the demo, so the docs site's own
 * links to `/` still reach the landing page.
 */
export default defineNuxtRouteMiddleware((to, from) => {
  if (!from.path.startsWith("/demo")) return;
  if (!APP_PATHS.has(to.path)) return;
  return navigateTo(to.path === "/" ? "/demo" : `/demo${to.path}`);
});
