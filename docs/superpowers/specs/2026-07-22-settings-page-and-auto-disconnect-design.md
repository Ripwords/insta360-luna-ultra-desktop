# Settings page, auto-disconnect, and UI pass

Date: 2026-07-22
Status: approved, ready for planning

## Problem

Three things, one release:

1. The home page doubles as a configuration form. The IP address input, the
   macOS Local Network troubleshooting list and the device detail table all sit
   on the first screen the user sees. Home should be a connect/disconnect
   surface and nothing else.
2. When the camera stops responding mid-session (Wi-Fi drops, camera sleeps,
   battery dies) the app keeps showing a connected session that no longer works.
   Requests hang or fail one by one with no session-level reaction.
3. The layout and visual detailing across the app have drifted. With a new page
   being added, this is the moment to do a targeted consistency pass.

## Scope

In scope: a new `/settings` route, a reduced home page, a camera-health
detector that force-disconnects, and a targeted visual pass over the existing
five surfaces.

Out of scope: any change to the Rust/Tauri command layer, the media indexing
logic, the RAW decode path, or the watermark rendering pipeline. No new
dependencies.

---

## 1. Settings page

New route `app/pages/settings.vue`, rendered in a `UDashboardPanel` like the
other pages. Reached from a new sidebar nav entry (`i-lucide-settings`) pinned
at the bottom of the nav list, and from the camera status chip in the sidebar
footer, which becomes a link to this page.

Three sections, in this order.

### Camera

- Host `UInput`, label above the field, persistent helper text below it
  ("Default Luna Ultra Wi-Fi gateway. Include a port for the dev mock:
  127.0.0.1:18080"). Not a placeholder-as-label.
- The value persists to `localStorage` under `luna-camera-host`, restored on
  boot. Today the host resets to the default on every launch, which is why
  users with a non-default gateway have to retype it every session. Persistence
  is what lets the home page ship a bare Connect button.
- Connect / Disconnect action for this section. Disconnect is styled as the
  destructive-adjacent action and is visually separated from the field group.
- The troubleshooting list (join the camera Wi-Fi, confirm the gateway, allow
  Local Network on macOS) moves here, shown inline under the field rather than
  only on error.
- When connected, the read-only device table renders here: device name,
  address, serial, firmware, file count. Values use tabular figures so they do
  not jitter as the library count changes.

### Watermark

The body of `DownloadOptionsModal` (the enable switch, the live
`WatermarkCanvas` preview and the position picker) is extracted into
`app/components/WatermarkSettingsForm.vue` and consumed by both the modal and
this page. The modal keeps its own title, footer and download button; only the
form body is shared. A "Reset to default" action is added here, wired to
`useWatermarkSettings().reset`, which already exists and is currently unused.

### Appearance

`ColorwayToggle` moves out of the sidebar footer into this section, with a
label and a one-line description. The sidebar footer is left with the update
banner and the camera status chip.

---

## 2. Home page reduced to connect / disconnect

`app/pages/index.vue` keeps the `LunaModel` visual and the headline and drops
the host form and the device table.

- **Disconnected**: headline, one line of subtext, a single primary
  "Connect camera" button that uses the persisted host, and a quiet secondary
  link to Downloads.
- **Connecting**: the same button in loading state, label "Connecting".
- **Connected**: the device name, the SSID or address as a single quiet line,
  a primary "Open gallery" button and a secondary "Disconnect".
- **Error**: a `UAlert` with the failure message and an "Open settings" link.
  No inline form on this page.

There is exactly one primary action per state. The `Disconnect` button
currently duplicated in the page navbar is removed, since the body now owns it.

---

## 3. Auto-disconnect on repeated camera failures

### The detector

New module `app/utils/cameraHealth.ts`, framework-free so it unit-tests without
Tauri or a Vue app instance:

```ts
export const FAILURE_THRESHOLD = 3;

export function armCameraHealth(onDead: () => void): void;
export function disarmCameraHealth(): void;
export function reportCameraSuccess(): void;
export function reportCameraFailure(): void;
```

Module-level state: the consecutive-failure count and the currently armed
callback. `armCameraHealth` resets the count to zero and stores the callback,
replacing any previous one. `disarmCameraHealth` clears both.

### What counts as a failure

Only **transport failures**: a thrown fetch. Connection refused, DNS failure,
socket timeout, Wi-Fi disappearing.

Any completed HTTP response resets the counter to zero, including a 404 or a 500. A camera that answers is a camera that is alive, so a genuinely missing
file must never kill the session. This is the single most important rule in the
detector and the reason the counter lives in the fetch layer rather than in the
image components.

### Where it hooks in

Inside `cameraFetch()` in `app/utils/lunaClient.ts`, the one function every
camera request already passes through: the library listing, grid thumbnails,
full-screen previews and RAW downloads. Wrapping it there means every request
type feeds the same counter, and no call site has to remember to report.

`reportCameraSuccess` / `reportCameraFailure` are no-ops while disarmed, so
requests made before a session exists cannot trip it.

### What happens on the third failure

The callback fires exactly once, then the detector disarms itself so a burst of
concurrent in-flight failures cannot fire it repeatedly.

`useCamera` arms the detector on a successful `connect()` and disarms it in
`disconnect()`. The callback runs a hard disconnect:

- `wantConnection = false`
- cancel the pending reconnect timer
- `await lunaClient.disconnect()`
- clear `info` and `library`
- set `error` to "Lost contact with the camera. Disconnected after 3 failed
  requests."

Setting `wantConnection = false` is what keeps the existing backoff reconnect
loop dormant, so the auto-reconnect machinery cannot immediately undo the
disconnect. The user reconnects deliberately, from home or from Settings.

The existing `luna://disconnected` Tauri event path is unchanged; it still
schedules a reconnect. The two mechanisms cover different failures: the event
means the control socket closed, the detector means the HTTP surface stopped
answering while the socket still looks open.

---

## 4. Layout and button placement

No new visual identity, no font change, no palette change. The app keeps its
Nuxt UI semantic tokens. This section is about where things sit on screen and
which button goes where.

### Rule applied everywhere

**One action row per surface, and destructive actions never sit flush against
the action you actually want.** Right now Download and Delete are adjacent
ghost buttons in the preview header, which is a mis-click waiting to happen on
files that cannot be recovered.

### Home

Currently the actions are split across two places: a Disconnect in the page
navbar and Connect / View downloads inside the body form.

- Remove the navbar Disconnect. The navbar keeps only the title and the sidebar
  collapse toggle.
- One action row in the body, left-aligned under the copy, primary first:
  - disconnected: `Connect camera` (primary), `View downloads` (ghost)
  - connected: `Open gallery` (primary), `Disconnect` (ghost, pushed to the
    right of the row with a gap so it is not adjacent to the primary)
- The 3D model column keeps its half of the split at `lg` and drops below the
  copy on narrower windows, as it does now.

### Media preview

Currently the header is `Download | Delete | Close` as three adjacent buttons
in the top-right, and the prev/next arrows float over the image edges.

- Header right becomes `Download` (outline, labeled), then a separator gap,
  then `Close`. Delete moves out of the row into an overflow menu
  (`i-lucide-ellipsis`) placed between them, so the destructive action takes
  two deliberate clicks.
- Filename and timestamp stay left-aligned in the header.
- Prev/next arrows stay vertically centered but move inside the image area's
  padding so they no longer overlap the image edge at wide aspect ratios.

### Gallery

- **"Select day" is currently invisible until hover** (`opacity-0` until
  `group-hover/day`). A hidden control that performs a real action should not
  be hover-gated. It becomes always visible but quiet (ghost, small), sitting
  to the right of the day heading and count.
- Toolbar keeps filters on the left and the thumbnail-size group on the right,
  which is the right split. The size buttons stay icon-only but keep their
  existing `aria-label`s.
- The loading state becomes tile-shaped skeleton cells in the actual grid
  rather than a centered spinner, so the layout does not jump when the library
  lands.
- The floating `SelectionBar` keeps its `pb-24` scroll reserve so it never
  covers the last row.

### Downloads

- Empty state gets the same centered icon plus copy plus action treatment the
  gallery already uses, with a `Go to gallery` action.
- A failed row gets an inline `Retry` button on the row itself, not in a global
  toolbar.

### Settings

- Single column, `max-w-2xl`, sections separated by a heading plus a divider.
  Not a two-column form; the fields are too few to justify it.
- Labels above inputs, helper text below, full width within the column.
- Each section's action sits at the section's bottom-right.
- Camera section: the field group first, then a divider, then
  Connect / Disconnect. Disconnect is visually separated from the input so it
  is never the thing you hit while tabbing out of the host field.

### Sidebar

- Settings joins the nav list at the bottom, separated from the three primary
  destinations by a spacer so it reads as secondary.
- The camera status chip in the footer becomes a link to `/settings`, since it
  is the thing users click when the connection looks wrong.

---

## Testing

Test-first, per project convention.

`tests/cameraHealth.test.ts`:

- three consecutive failures invoke the callback exactly once
- a success between failures resets the counter, so failure/success/failure/
  failure does not fire
- failures while disarmed are ignored, and arming afterwards starts from zero
- a fourth and fifth failure after the callback has fired do not invoke it
  again
- `armCameraHealth` called twice replaces the callback rather than stacking

The existing suites (`cameraQueue`, `lunaIndex`, `media`, `watermark`, and the
rest) must stay green; `cameraFetch` gains a wrapper and its behavior on the
success path must not change.

Manual verification, since the detector's real trigger cannot be unit-tested:
connect to the camera or the mock server, kill the server, browse the gallery,
and confirm the session drops to disconnected with the failure message after
three failed requests, and that it does not silently reconnect.

## Risks

- **False positives.** A camera under heavy load could time out three times in
  a row while still being reachable. Mitigated by counting only transport
  failures, and by the fact that a single completed response resets the count.
  If this proves too eager in practice, the threshold is one constant.
- **Shared state across the app.** `cameraHealth` holds module-level state,
  matching the existing pattern in `useCamera` (`retryTimer`,
  `networkWatcherInstalled`). Tests must reset it between cases, so the module
  exposes `disarmCameraHealth` for that purpose.
- **Scope creep in the visual pass.** The pass is bounded to the levers listed
  above. Anything that would require restructuring the gallery virtualization
  or the download queue is out of scope for this change.
