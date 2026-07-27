import { setCameraTransport } from "#layer/utils/transport";
import { createMockTransport, type MockState } from "../mocks/mockClient";
import { presetOrDefault } from "../mocks/presets";

/**
 * Client-only by necessity, not preference. The transport registry is a
 * process-global module variable; this site runs `ssr: true`, so registering
 * on the server would share one visitor's camera state with every concurrent
 * render. See the lifetime note in app/utils/transport.ts.
 *
 * Registration is deferred to `onNuxtReady` rather than done eagerly here at
 * plugin-init time (which runs before the client's first hydration pass).
 * Eager registration makes `useCamera`'s `available` computed read `true` on
 * the client while the prerendered HTML was built against the real,
 * unregistered transport (`available` false) — a hydration mismatch. Vue only
 * half-corrects that class of mismatch: it rebuilds mismatched structural
 * `v-if` content (the "desktop app required" alert does vanish), but leaves
 * an already-hydrated boolean *attribute* alone (verified empirically: the
 * Connect button's `disabled` attribute survived hydration stuck at the
 * server's value, permanently disabling the one button the whole demo hinges
 * on). `nuxtApp.hook("app:mounted", ...)` was tried first and isn't early
 * enough either — it still fires while Vue's own hydration bookkeeping for
 * the page is in flight, so forcing the remount below from inside it
 * produced a *second*, self-inflicted mismatch. `onNuxtReady` waits until the
 * app is genuinely idle, past all of that, and neither problem occurs from
 * there.
 *
 * Once idle, registering the mock and bumping `demo-remount-key` (read by
 * `app.vue`'s `<NuxtPage :key>`) remounts the current page fresh against the
 * now-registered mock, as an ordinary client-side render rather than a
 * hydration reconciliation, so the first paint still ends up fully correct.
 *
 * Scoped to /demo routes only: registering (and bumping the remount key)
 * unconditionally on every route bought docs pages a forced full remount for
 * a problem only /demo has. A visitor can also arrive at /demo via client-side
 * navigation from a docs page well after `onNuxtReady` has already fired for
 * the docs page it started on — the route watcher below covers that case by
 * registering lazily the first time the route becomes /demo, rather than
 * only checking once at startup.
 */
export default defineNuxtPlugin(() => {
  const route = useRoute();
  const remountKey = useState("demo-remount-key", () => 0);
  let registered = false;

  function isDemoRoute(): boolean {
    return route.path === "/demo" || route.path.startsWith("/demo/");
  }

  /**
   * The bare Connect screen. Nitro's trailing-slash normalization means
   * `route.path` is actually `"/demo/"`, not `"/demo"`, once this is running
   * against the generated static site — verified empirically (a plain
   * `=== "/demo"` check silently never matched, and the "always excluded"
   * route below auto-connected anyway). Checking both forms keeps this
   * correct regardless of which one a given environment produces.
   */
  function isBareConnectRoute(): boolean {
    return route.path === "/demo" || route.path === "/demo/";
  }

  /**
   * `::demo{preset="..."}` (Task 6) round-trips its preset through this query
   * param so an embed opens already in the situation its prose describes,
   * rather than always in the same freshly-connected state.
   */
  function queryPreset(): string | undefined {
    const value = route.query.preset;
    return typeof value === "string" ? value : undefined;
  }

  /**
   * `useCamera()`'s `status` starts `"disconnected"` and only a user-driven
   * `connect()` ever flips it — the mock's own seed `connected: true` isn't
   * enough by itself, since nothing reads `MockState.connected` until
   * something calls `status()`/`probe()`, and the app never polls those on
   * mount. Left alone, every embed opened "connected" via a preset still
   * renders gallery.vue's/camera.vue's "No camera connected" empty state.
   *
   * `/demo` itself (the bare Connect screen) is deliberately excluded: its
   * whole purpose is to demonstrate the connect flow, so it must keep
   * showing a real, clickable Connect button rather than being connected
   * out from under the reader. Every other `/demo/*` screen has no Connect
   * button of its own — an embed pointed at one has no way to reach a
   * connected state except this — so those auto-connect whenever the
   * resolved preset seeds `connected: true` (the default for every preset
   * currently defined; only a future disconnected-by-design preset would
   * skip this).
   *
   * Ordering matters: `setCameraTransport` above must run first, since
   * `connect()` calls `getCameraTransport().available` — connecting before
   * registration would hit the real (unregistered) transport and fail with
   * "Camera control requires the desktop app." `connect()` itself is async
   * (the mock adds a 600ms delay so its own loading state is visible) but is
   * not awaited here: it self-guards on `isConnected`/`isBusy`, so firing it
   * and moving on is safe, and there's nothing after it in this function to
   * sequence against.
   *
   * No double-connect risk from a reader manually connecting afterwards:
   * this only ever runs once per page load (guarded by `registered` above),
   * and it never runs on `/demo`, the only route with a Connect button to
   * click.
   */
  function connectIfSeededConnected(seed: Partial<MockState>): void {
    if (isBareConnectRoute() || !seed.connected) return;
    void useCamera().connect();
  }

  function registerIfOnDemo(): void {
    if (registered || !isDemoRoute()) return;
    registered = true;
    const seed = presetOrDefault(queryPreset());
    setCameraTransport(createMockTransport(seed));
    remountKey.value += 1;
    connectIfSeededConnected(seed);
  }

  onNuxtReady(() => {
    registerIfOnDemo();
    if (registered) return;
    const stop = watch(
      () => route.path,
      () => {
        registerIfOnDemo();
        if (registered) stop();
      },
    );
  });
});
