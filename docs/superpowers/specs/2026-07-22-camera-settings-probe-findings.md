# Camera Settings Probe — Findings

Date: 2026-07-22
Source: `node scripts/probe-settings.mjs --host 192.168.42.1`
Device: Insta360 Luna Ultra, firmware v1.0.47, serial BTLA3ABEGUDR3S

## Headline

**Photographic control is fully confirmed. Gimbal control is not reachable
through the options API and needs a packet capture.**

The camera acknowledged **50 of 50** photography option types in both video
and photo modes, and **33 of 103** device option types. Nothing came back that
the vendored schema could not explain — there were zero `unknown, wire N`
fields, so `PhotographyOptions` and `Options` are structurally accurate for
2026 firmware.

## Confirmed — safe to build against

Every one of these was acknowledged in both `FUNCTION_MODE_NORMAL_VIDEO` and
`FUNCTION_MODE_NORMAL_IMAGE`:

| Area          | Option types                                                                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exposure      | `EXPOSURE_MODE`, `EXPOSURE_PROG`, `EXPOSURE_MANUAL`, `EXPOSURE_BIAS`, `EV_INDEX`, `LONG_EXPOSURE_MANUAL`, `STILL_EXPOSURE_OPTIONS`, `VIDEO_EXPOSURE_OPTIONS`, `VIDEO_ISO_TOP_LIMIT` |
| Metering      | `AE_METER_MODE`, `AE_MANUAL_METER_WEIGHT`, `METERING_ENABLE`                                                                                                                        |
| Colour        | `WHITE_BALANCE`, `WHITE_BALANCE_VALUE`, `VIDEO_GAMMA_MODE`, `COLOR_MODE`, `BRIGHTNESS`, `CONTRAST`, `SATURATION`, `HUE`, `SHARPNESS`, `FLICKER`                                     |
| **Zoom**      | **`ZOOM_SCALE`**, `FOCAL_LENGTH_VALUE`, `FOV_TYPE`                                                                                                                                  |
| Format        | `RECORD_RESOLUTION`, `PHOTO_RESOLUTION`, `PHOTO_SIZE_ID`, `PHOTO_GRAPHY_BITRATE`, `RES_REC_LIMIT`, `RAW_CAPTURE_TYPE`                                                               |
| Capture       | `PHOTOGRAPHY_SELF_TIMER`, `AEB_CAPTURE_NUM`, `BURST_CAPTURE_NUM`, `BURST_CAPTURE_TIME`, `CACHE_CAPTURE_NUM`, `CACHE_CAPTURE_ENABLE`, `RECORD_DURAION`, `REMAINING_TIME`             |
| Stabilisation | `FLOWSTATE_BASE_TYPE`, `FLOWSTATE_LEVEL`, `DARK_EIS_ENABLE`, `PREVIEW_MCTF_ENABLE`, `PREVIEW_SPORT_MODE_ENABLE`, `PREVIEW_SPORT_LEVEL`                                              |

Device state from `GET_OPTIONS`: `battery_status` (83%, type THICK),
`storage_state` (95.9 GB free of 128 GB), `firmwareRevision` v1.0.47,
`camera_type` "Insta360 Luna Ultra", `wifi_info`, `serial_number`,
`video_encode_type` ENCODE_H265, `camera_posture`, `photo_sub_mode`,
`video_sub_mode`, `pressOptions`, `camera_language`.

Live values read at probe time included `color_mode = COLOR_MODE_LOG`,
`fov_type = FOV_WIDE`, `record_resolution = RES_1280_720P30`,
`zoom_scale = 1`, `gamma_mode = STANDARD`, `flicker = FLICKER_AUTO`.

**Zoom is solved.** `ZOOM_SCALE` is a first-class photography option and read
back as `1`. My earlier ~50% estimate was too pessimistic.

## Not reachable — gimbal

`PTZ_CTRL` (option type 87) returned `1200` — field 2 present, length zero,
and **no echo of the option type in field 1**. Contrast a supported option,
`CAMERA_POSTURE`, which echoed `085d` (field 1 = 93) followed by its value.
The missing echo is the camera saying it does not serve this option here.

`CALIBRATION_ORIENTATION` behaved the same way.

`camera_posture` is only orientation (`CAMERA_POSTURE_ROTATE_90`) — which way
up the body is held, not where the gimbal is pointing.

**Conclusion: gimbal pan/tilt is not exposed through `GET_OPTIONS`/`SET_OPTIONS`.**
It must live behind command codes above 15, which no public reverse-engineering
covers. A packet capture of the phone app while panning is the only way in.

## Lead — subject tracking

`WINDOW_CROP_INFO` (option type 124) is supported and decodes cleanly:

```
src_width, src_height, dst_width, dst_height, crop_offset_x, crop_offset_y
```

All zero while idle. That is exactly the shape a digital reframing window
would take. Worth re-running the probe **while Deep Track is actively
following a subject** — if these populate, tracking state is observable
through the options API even if the command to _start_ tracking is not.

## New enum values to fill in

The structure is right but a few values postdate the schema:

| Field                    | Value | Note                                          |
| ------------------------ | ----- | --------------------------------------------- |
| `photo_sub_mode`         | 8     | `PhotoSubMode` stops at 7 (`PHOTO_STARLAPSE`) |
| `photo_resolution`       | 9     | not in `PhotoSize`                            |
| `storage_state.location` | 3     | not in `CardLocation`                         |

## Caveat when reading results

proto3 omits default values, so a field absent from a response is not the same
as unsupported — `iso = 0` and `exposure_mode = AUTO` simply do not serialise.
**The field-1 echo is the support signal**, not the presence of a value.

## Revised confidence

| Feature                               | Before | After                                         |
| ------------------------------------- | ------ | --------------------------------------------- |
| Exposure / ISO / shutter / WB / EV    | ~85%   | **confirmed**                                 |
| Colour, gamma, Leica looks            | ~85%   | **confirmed**                                 |
| Zoom                                  | ~50%   | **confirmed** (`ZOOM_SCALE`)                  |
| Resolution / bitrate / FOV / format   | ~85%   | **confirmed**                                 |
| Capture modes, self-timer, burst, AEB | ~70%   | **confirmed** (a few new enum values)         |
| Battery / storage / device state      | ~85%   | **confirmed**                                 |
| Record start/stop                     | ~85%   | untested — needs a write command              |
| Gimbal pan/tilt                       | ~15%   | **blocked** on packet capture                 |
| Deep Track subject select             | ~10%   | **blocked**, but `WINDOW_CROP_INFO` is a lead |
