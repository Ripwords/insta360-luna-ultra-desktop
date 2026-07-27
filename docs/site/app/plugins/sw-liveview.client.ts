/**
 * Registers `public/sw.js`, which paces the live-view fixture to roughly its
 * real encoded duration instead of letting it arrive as one instant localhost
 * download (see that file's own comment for the full "why").
 *
 * Being in `public/`, the script is served at the site's base path root
 * (`${baseURL}sw.js`), so its default scope — the directory containing it —
 * already covers the whole site, including `${baseURL}demo/fixtures/...`.
 *
 * Registration is best-effort: if the browser has no Service Worker support,
 * or registration itself fails for any reason, live view still works, just
 * unpaced (today's behaviour) — this is a nicety layered on top, never a
 * requirement for the demo to function.
 */
export default defineNuxtPlugin(() => {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  const { app } = useRuntimeConfig();
  navigator.serviceWorker.register(`${app.baseURL}sw.js`, { scope: app.baseURL }).catch((cause) => {
    console.warn("Live-view pacing service worker failed to register:", cause);
  });
});
