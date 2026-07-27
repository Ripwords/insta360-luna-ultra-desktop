export default defineAppConfig({
  ui: {
    // `@nuxt/ui`'s default `DashboardPanel` root carries `min-h-svh`, which
    // pins the panel to at least the *real* browser viewport's small-viewport
    // height. That's right for the desktop app's own top-level window — there
    // is nothing else to size it against — but wrong here: on a top-level
    // `/demo/*` visit the panel actually lives inside the fixed-height macOS
    // window box `app/layouts/demo.vue` draws around it. That layout gives
    // `AppShell`'s `UDashboardGroup` (`fixed inset-0`) a correct, smaller
    // containing block via a `translateZ(0)` transform on an ancestor — see
    // its long comment — but viewport units are immune to that trick; `svh`
    // always measures the real browser window, transform or not. So the
    // panel kept forcing itself taller than the window box on any real
    // viewport taller than the window, and the camera page's flex column
    // (viewfinder `flex-1`, capture bar fixed at the bottom) grew to match —
    // pushing the shutter and capture-mode strip below the window's clipped
    // bottom edge, invisible and unclickable.
    //
    // Dropping the min-height (`min-h-0`, which tailwind-merge resolves
    // against the base theme's `min-h-svh` since both set `min-height`)
    // leaves the panel to just stretch to fill its flex parent — the
    // dashboard group's `fixed inset-0` row — which is exactly the window's
    // own content area in both the top-level and embedded case, and matches
    // the real desktop app too (`UDashboardGroup` fills its host window
    // either way).
    dashboardPanel: {
      slots: {
        root: "min-h-0",
      },
    },
  },
});
