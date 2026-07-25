# Camera protocol calibration — colour modes, filters, filter strength

**Measured on:** Insta360 Luna Ultra, firmware **v1.0.238**, 2026-07-25.
**Tool:** `scripts/probe-colorspace.mjs`
**Applied in:** `ENUM_OVERRIDES` / `ENUM_ADDITIONS` / `MESSAGE_ADDITIONS` in `scripts/build-schema.mjs`

## Run this after any firmware update

```
node scripts/probe-colorspace.mjs calibrate
```

One pass, read-only, prompts you through every setting and prints a paste-ready
override block. Nothing else in this document is needed unless `calibrate`
finds a lever has moved to a field it does not watch.

Before starting: **Color Mode = Standard, resolution 4K30 or lower, normal Video
mode.** Filters are unavailable above 4K60, and a greyed-out picker records the
*previous* value again rather than the one being asked for.

## Why re-calibration is not optional

The vendored extraction (`scripts/luna-protocol-schema.json`) describes a
2020-era camera. Every picture-profile field checked so far disagrees with it:

| Field | Extraction says | Camera actually does |
|---|---|---|
| `color_mode` | NORMAL=0, LOG=1, VIVID=2, HDR=3 | 1, 2, 5 — and no VIVID |
| `gamma_mode` | a gamma curve, values 0–13 | the **Filter** picker, values 0/15/16/24/26/34–38 |
| `filter_intensity` | does not exist | field 104, option type 104 |

The failure mode when these drift is silent and nasty: the camera **accepts**
the write, **echoes** the option type as successful, and **reads back** a value
that the stale enum happily renders under the wrong name. Nothing errors. The
only witness is the camera's own screen.

That is exactly how the app shipped for months claiming to be in i-Log while
sitting in Standard.

## The measured values

### Colour mode — `color_mode`, field 35, option type `COLOR_MODE`

| Camera UI | Value |
|---|---|
| Standard | 1 |
| I-Log | 2 |
| Dolby Vision | 5 |

0, 3 and 4 were never observed and are deliberately left unnamed.

### Filter — `gamma_mode`, field 18, option type `VIDEO_GAMMA_MODE`

| Camera UI | Value | Strength? |
|---|---|---|
| Original | 0 | — |
| Leica Natural | 15 | — |
| Leica Vivid | 16 | — |
| Leica Chrome | 36 | — |
| NC Film | 24 | ✓ |
| CC Film | 26 | ✓ |
| Pos Film | 34 | ✓ |
| Neg Film | 35 | ✓ |
| Cinematic | 37 | ✓ |
| Fresh | 38 | ✓ |

The numbering is genuinely non-contiguous, and Leica Chrome genuinely sits at 36
among the film filters rather than beside its siblings at 15/16. Both were
re-measured because they looked like errors. They are not.

### Filter strength — `filter_intensity`, field 104, option type `FILTER_INTENSITY`

| Camera UI | Value |
|---|---|
| Low | 1 |
| Medium | 2 |
| High | 3 |

Only the six cinematic filters expose this; the three Leica profiles have no
strength. The setting is **global** — it persists across filter changes, so it
holds its last value even while a Leica profile is selected.

## Facts about the protocol worth keeping

- **Option type number == field number.** True for all 60 types this firmware has
  beyond the extraction's 54. Confirmed by asking for one type alone and seeing
  which field comes back. This is what lets a field discovered by reading be
  written without further guesswork.
- **Picture-profile fields mirror across all four function modes.** Setting
  `color_mode` or `gamma_mode` for `FUNCTION_MODE_NORMAL_VIDEO` changes it for
  `HDR_VIDEO`, `NORMAL_IMAGE` and `HDR_IMAGE` too, so one write covers everything.
- **`$supported` cannot gate the UI.** The camera lists an option type as
  supported wherever it will *parse* it, which includes modes whose own UI has no
  such picker. Availability rules come from the manual, in
  `app/utils/cameraCapabilities.ts`.
- **proto3 defaults are invisible.** A field at its zero value is omitted from
  the response entirely. For these fields 0 is a real setting (Original / no
  filter), so absence means zero, not "unknown".
- **This firmware has 60 photography option types the extraction lacks** (47–110),
  and no device option types beyond it.

## How each lever was found, if one moves again

The method is always the same: **snapshot, change one thing on the camera,
snapshot again, diff.** Whoever makes the change is irrelevant, so phone-app
traffic never needs sniffing.

1. `pair <before> <after> --all` — the workhorse. Snapshots, waits at a prompt
   while you change the setting, snapshots again, diffs. One connection.
2. `series <label>...` — same, for a list of values, and prints a matrix of
   everything that varied. This is what produced the filter table.
3. `scan --max 200` — walks option-type *numbers* past the end of the vendored
   enum to find types this firmware answers to. Needed when a setting has no
   field in the schema at all, which is how filter strength was found.
4. `snapshot` / `diff` — the manual two-step, for snapshots taken minutes or
   reboots apart.

### Traps that cost real time

- **Running two `snapshot` commands from one paste.** They execute back to back
  with nobody touching the camera in between, and the diff then truthfully
  reports that nothing moved. Three rounds were lost to this. `pair` and
  `series` exist to make it impossible; prefer them always.
- **A first snapshot that assumes the camera is already in the starting state.**
  It records whatever the previous run left behind, and a first row that is
  really the last run's leftovers looks exactly like two settings colliding on
  one number. `series` now prompts before the first step too.
- **`--all` bounded by the vendored enum.** The enum stops at 54 and filter
  strength is at 104, so a sweep bounded by it comes back clean while missing the
  thing entirely. `--all` sweeps numbers, not enum keys.
- **Probing while the camera is in a state that disables the setting.** One round
  ran entirely in Dolby Vision; another at 8K. Both produce a null result that
  looks like a finding.
- **Sanity-check the gap.** `media_time` is the camera's own clock. If two
  snapshots are closer together than a trip to the camera takes, nobody changed
  anything.

## Where the manual is wrong

**Dolby Vision has no filters.** The manual's filters page lists Dolby Vision
among the filter-supporting modes. On the camera it is not: there is no filter
picker in Dolby Vision, and passing *through* Dolby Vision clears whatever filter
was set — it does not come back on returning to Standard or i-Log.

Standard and i-Log both do allow filters. All three modes were checked
on-device, so Dolby Vision is the only exclusion and the list is complete.
Encoded as `COLOR_MODES_WITHOUT_FILTERS` in `app/utils/cameraCapabilities.ts`.

**Pano HDR does not exist.** The extraction defines `PHOTO_INSTA_PANO_HDR` and
`FUNCTION_MODE_HDR_POWER_PANO_IMAGE`; the camera has no such mode. Removed from
`CAPTURE_MODES`.

**Pano is ONE sub-mode with an aspect setting**, not two modes. `photo_sub_mode`
reads **8** (a value the extraction cannot name) for both 360 and 2:1, and the
aspect rides on **field 98 / option type 98**: `1` = 360, `4` = 2:1.

Separating that from its co-travellers needed a negative control. Switching the
Pano aspect moved four fields at once — `pano_aspect`, `photo_resolution`,
`remaining_time` and field 99. Changing the photo resolution in *ordinary Photo
mode* then moved `photo_resolution` and `remaining_time` while field 98 stayed
at 1, which is what proves 98 tracks the aspect rather than the shot size.
Field 99 decodes to `{remaining_time, 3}` — derived, not a lever.

**`PhotoSubMode` drifted as well.** Photo is 0, Pano is **8** — not the
extraction's `PHOTO_INSTA_PANO = 5`. Selecting Pano sent 5, the camera did not
recognise it, and it stayed in ordinary Photo mode. Everything downstream failed
with it: `pano_aspect` writes came back rejected because the camera was never in
Pano to apply them to. A wrong sub-mode does not fail loudly; it just leaves you
in the previous mode.

`PHOTO_NONE = 100` is inferred from `VIDEO_NONE = 100` rather than measured, and
mode detection needs it. UltraPhoto's value is still unmeasured.

### Video sub-modes (confirmed unchanged from the extraction)

| Camera UI | `video_sub_mode` |
|---|---|
| Video | 0 |
| PureVideo | 11 |
| Slow-mo | 9 |
| Timelapse | 2 |

**Changing colour mode rewrites other settings.** `sharpness` was measured moving
1 → 2 → 1 across an i-Log → Standard → i-Log round trip. Any write that changes
the colour mode must be followed by a full re-read; verifying just the one option
leaves the rest of the panel showing values the camera has already discarded.

## Mode / colour-mode rules (confirmed on-device)

| Capture mode | Colour modes | Filters | Reset on entry |
|---|---|---|---|
| Video | Standard, i-Log, Dolby Vision | yes (not in DV) | no |
| PureVideo | Standard only | yes | **yes** |
| Slow-mo | Standard only | yes | **yes** |
| Timelapse | Standard only | yes | **yes** |
| Photo | no picker | yes | no |
| Pano | no picker | — | **yes** |

**The camera does not reset for you.** Switching into a Standard-only mode from
i-Log or Dolby Vision leaves `color_mode` where it was, so the app would show
Standard — the only value it can offer there — while the camera shot something
else. `selectMode` writes `color_mode = Standard` and `gamma_mode = FILTER_NONE`
on entering any of those modes rather than assuming.

## The dividing line: stored settings yes, live control no

Five features were driven successfully. Five were chased and abandoned. The
split is not luck — it is the shape of what this protocol exposes.

| Reachable (a stored option) | Not reachable (live or interactive) |
|---|---|
| Colour modes | Colour Recovery |
| Filters + strength | Deep Track (status only, not settable) |
| Pano aspect | Tap to focus |
| Capture modes | Gimbal control |
| Zoom (`zoom_scale`) | Gimbal attitude |

Everything in the left column is a value the camera stores and reports. Nothing
in the right column is. Before spending a day on the next feature, ask which
column it belongs in.

**Gimbal, specifically.** `PTZ_CTRL` is option type 87 and the only pan/tilt
name in the schema, but `Options` has no field 87 — the type has a name and no
payload, which is why it answers empty. `PHONE_COMMAND_GET_GYRO` (19) is
defined (`GetGyro { count }` → `GetGyroResp { gyroes: bytes }`, samples of
`Gyro { ax, ay, az, gx, gy, gz }`) but **answers nothing to any of 20 request
shapes**, so it is not implemented here.
`NotificationCameraPostureUpdate` carries only ROTATE_0/90/180/270/UP/DOWN —
"is the camera upside down", not an angle. Device field 176 looks like attitude
at a glance and is storage free/total repeated.

**Deep Track** is photography field 91, a nested `{2, 2, 3, state}`. Toggling it
on the camera drives `state` 2 <-> 5, so the field is real — but writing it comes
back `differs`, and the value read on connect did not match the camera. It is
status we cannot interpret, so every field stays a raw number and there is no
control in the app.

The only remaining route for the right-hand column is capturing the phone app's
traffic (`scripts/decode-capture.mjs`), because those commands demonstrably exist
— the phone issues them — they just never touch anything we can read.

## Colour Recovery: not reachable on this protocol

Firmware v1.0.283 added Colour Recovery — an i-Log-only monitoring mode that
shows a colour-corrected preview of log footage and disables filters while on.
It visibly changes the preview, so the setting is real. It is not observable
anywhere on the control protocol. Exhausted, all read-only:

| Probed | Result |
|---|---|
| Photography option types 1–400 | nothing returns a value above 104 |
| Device option types 1–400 | 12 unnamed types found; none move with the toggle |
| The 11 named `PHONE_COMMAND_GET_*` commands | unchanged |
| `GET_SUBMODE_OPTIONS` (43), 16 request shapes | every one empty |
| Unsolicited notifications (`listen`) | nothing correlates with any setting |

**A camera that echoes anything.** Asked for photography option types 1–400 it
echoed back 399 of them, including hundreds that cannot exist. The echo in
field 1 is NOT evidence of support — only a returned VALUE is. `scan` originally
treated the echo as the signal and reported 349 phantom types; it now requires a
value. Silence and support are indistinguishable on this camera.

Only unnamed command codes above 152 remain untried, and firing those blind is
refused by design: an unnamed code could be a setter, a format or a reset.

## Things deliberately not done

- **Command codes above 152 were never scanned.** This firmware certainly has
  them, but an unnamed code could be a setter or something destructive, and a
  read-only probe has no business guessing. Only codes the schema names
  `PHONE_COMMAND_GET_*` are probed.
- **No Dolby Vision resolution matrix.** Insta360 publishes none, so no guard was
  written for it. Marketing claims up to 8K30 DV; there is no per-mode spec.
- **No further colour-mode/filter combinations left open.** All three were
  checked on-device: Standard and i-Log both allow filters, Dolby Vision does
  not. See "Where the manual is wrong".

## Sources for the availability rules

- [Filter settings](https://onlinemanual.insta360.com/lunaultra/en-us/operation-tutorials/shooting-preview/shooting-specs/filters)
- [I-Log mode](https://onlinemanual.insta360.com/lunaultra/en-us/operation-tutorials/shooting-preview/shooting-specs/i-log)
- [Basic and Pro mode](https://onlinemanual.insta360.com/lunaultra/en-us/operation-tutorials/shooting-preview/shooting-specs/normal-professional-mode)
- [Photo & video specifications](https://onlinemanual.insta360.com/lunaultra/en-us/specs/shooting)
