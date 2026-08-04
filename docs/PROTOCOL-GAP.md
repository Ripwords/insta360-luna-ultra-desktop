# Protocol gap — the 65% of the control protocol this project cannot name

Every parked feature in [`FEATURES.md`](FEATURES.md) was hunted through the
**options** namespace. All four of them live in the **command** namespace, in
the part of the protocol our schema has never described.

Extracted **2026-08-03** from the Insta360 Android app **2.30.0**
(`com.arashivision.insta360akiko`, released 2026-07-29), by reading message-code
and `.proto` string literals out of `base.apk`'s `classes.dex`.

|                                              |         |
| -------------------------------------------- | ------- |
| Codes in `scripts/luna-protocol-schema.json` | **164** |
| Codes in the 2026 app                        | **459** |
| Not in our schema                            | **297** |
| **Coverage**                                 | **35%** |

## Read this before using any of it

**These are names, not numbers — nothing here is sendable.** The app is
protected by AppShield: `classes.dex` is a 6 KB stub followed by 110 MB of
encrypted payload that `libashield.so` decrypts at runtime. String literals
survive in the clear, which is why the names read out; the `<clinit>` bytecode
holding each name's integer value does not.

Verified three ways rather than assumed: the dex `map_list` shows the real dex
ending at offset ~6,212 with everything after it appended payload; no
`string_ids` table is recoverable from that payload (longest ascending pointer
run is 2 entries, i.e. noise); and the stub imports `Lcom/ashield/Stub;`.

**A name in the app does not mean the Luna implements it.** That app drives
dozens of Insta360 cameras, so this file says what to look for, not what works.
The camera's firmware would settle it and cannot be read — see
[Getting the numbers](#getting-the-numbers). Until something confirms a name
against this device, treat every one of them as a lead.

**One name is corroborated by live capture.**
`CAMERA_NOTIFICATION_PTZ_STATE` is almost certainly the code-8302 traffic
observed from the camera on 2026-08-03 — an 18-byte, 9-varint message in which
field 2 and field 3 toggle 1 → 0 as the gimbal reaches its pan limits. Two
distinct flags for two distinct directions, in two clean time clusters.

## Where the 297 sit

| Area                       | Count  | Note                                            |
| -------------------------- | ------ | ----------------------------------------------- |
| Uncategorised              | 87     | Needs a second pass                             |
| Storage / files            | 35     |                                                 |
| On-camera playback         | 23     | A subsystem this app has nothing for            |
| AI features                | 21     | AiRetouch, assistant, translate, QuickReader    |
| Interval / timed recording | 20     |                                                 |
| Factory / service          | 19     | Includes two PTZ entries                        |
| Wi-Fi management           | 18     |                                                 |
| **Gimbal / PTZ**           | **14** | **Top priority**                                |
| Live streaming             | 13     |                                                 |
| Bluetooth / remote         | 10     |                                                 |
| Subject tracking           | 9      | This is Deep Track                              |
| Power / lifecycle          | 9      |                                                 |
| Find My / locate           | 7      |                                                 |
| Pre-record / loop          | 7      |                                                 |
| Zoom                       | 3      | Dedicated commands, not the `zoom_scale` option |
| Focus                      | 2      | This is tap to focus                            |

Full lists: [`protocol-gap/message-codes.txt`](protocol-gap/message-codes.txt)
(459 names), [`protocol-gap/proto-files.txt`](protocol-gap/proto-files.txt)
(307 `.proto` filenames), [`protocol-gap/feature-map.json`](protocol-gap/feature-map.json).

## Gimbal / PTZ

```
PHONE_COMMAND_GIMBAL_CONTROL                    <- the one
PHONE_COMMAND_GET_PTZ_OPTION
PHONE_COMMAND_SET_PTZ_OPTION
PHONE_COMMAND_GET_PTZ_TRACK_STATE
PHONE_COMMAND_CANCEL_ANGLE_FIXED
PHONE_COMMAND_SET_BOX_LOCK_ANGLE
FACTORY_COMMAND_GET_PTZ_CTRL_OPTION
FACTORY_COMMAND_SET_PTZ_CTRL_OPTION
CAMERA_NOTIFICATION_PTZ_STATE                   <- matches observed code 8302
CAMERA_NOTIFICATION_PTZ_TRACK_STATE
CAMERA_NOTIFICATION_PTZ_PERSPECTIVE_STATUS
CAMERA_NOTIFICATION_VIRTUAL_PTZ_MOVEMENT_STATUS
CAMERA_NOTIFICATION_GIMBAL_CALIBRATION
CAMERA_NOTIFICATION_HAND_CONTROL
```

The message shapes are named too:

```
commands/gimbal_control.proto        commands/gimbal_pitch_config.proto
ptz.proto                            gimbal_status.proto
virtual_ptz.proto                    notifications/gimbal_calibration.proto
notifications/ptz_perspective_status.proto
notifications/ptz_track_state.proto
```

`PTZ_CTRL` answered empty as option type 87 because gimbal control was never an
option. It is its own command, with its own message.

## Subject tracking — this is Deep Track

```
PHONE_COMMAND_OPEN_TRACKING
PHONE_COMMAND_OPEN_TRACKING_WITH_RECT           <- a rect: tap to track
PHONE_COMMAND_CLOSE_TRACKING
PHONE_COMMAND_CANCEL_TRACKING
PHONE_COMMAND_SWITCH_TRACK_TARGET
PHONE_COMMAND_START_TRACK_AUTO_DETECT
PHONE_COMMAND_TRACK_USER_OPS
CAMERA_NOTIFICATION_TRACK_SYNC
```

```
commands/open_tracking.proto         commands/close_tracking.proto
commands/switch_track_target.proto   commands/start_track_auto_detect.proto
notifications/track.proto            stream_track_data.proto
track_ui_ops.proto
```

`FEATURES.md` reads Deep Track as photography field 91 — real, readable, and
not writable. That is consistent: field 91 is the status mirror, and the control
is a command.

## Focus — this is tap to focus

```
CAMERA_NOTIFICATION_FOCUS_STATE
CAMERA_NOTIFICATION_AF_SCENE_CHANGE
```

```
af_lens_info.proto                   notifications/focus_state.proto
notifications/auto_focus_mode.proto
```

"No stored option corresponds to it" was right, and was the wrong place to look.

## Zoom — shipping already, through the wrong mechanism

```
PHONE_COMMAND_GET_ZOOM
PHONE_COMMAND_SET_ZOOM
CAMERA_NOTIFICATION_ZOOM
```

Zoom works today via the `zoom_scale` option. Dedicated commands exist, and a
`CAMERA_NOTIFICATION_ZOOM` push would remove the read-back guesswork.

## On-camera playback — 23 codes, nothing built

`ENTER_PLAYBACK` / `EXIT_PLAYBACK`, `PLAYBACK_PLAY` / `PAUSE` / `RESUME` /
`STOP` / `SEEK` / `PLAY_NEXT` / `PLAY_PREV`, `GET_PLAYBACK_FILELIST`,
`PLAYBACK_GET_THUMB`, `PLAYBACK_DEL_FILE`, `ENTER_THUMB` / `EXIT_THUMB`, plus
`PLAYBACK_STATUS` and `REFRESH_PLAYBACK_LIST` notifications.

Driving playback on the camera's own screen from the desktop is not possible
today in any form.

## Pre-record / loop recording — 7 codes, nothing built

```
PHONE_COMMAND_START_PRE_REC / STOP_PRE_REC / SET_PRE_REC_TIME / CTRL_PRE_RECORD
PHONE_COMMAND_START_LOOPRECORDING_CAPTURE / STOP_LOOPRECORDING_CAPTURE
PHONE_COMMAND_HIGHLIGHT_REC_TIME
```

Capture modes that do not appear in the app's mode strip at all.

## What this corrects

The calibration spec concluded that the reachable/unreachable split was "not
luck — it is the shape of what this protocol exposes," and drew the line at
stored-versus-live.

That was right about the symptom and wrong about the cause. The line was
**the half of the protocol our schema documents versus the half it does not**.
Everything that turned out to be reachable happened to sit in the 164 codes we
could name.

The practical consequence: "no stored option corresponds to it" is not evidence
a feature is unreachable. It is evidence the feature is a command.

## Getting the numbers

**The firmware is encrypted — do not spend a day on it.** Checked 2026-08-04
against `Insta360LunaUltraFW-8BF2D77FENC-V1.0.288.bin` (1.78 GB, the `ENC` in
the name is literal). It is an `MWFI` container: a 4 KB header carrying the
magic, a format version, the model code `z03`, the string `1.0.288` and three
small integers — then one opaque blob. Shannon entropy is **8.00 across every
sample from 0% to 99%** of the payload, there is no section table, and zero
`PHONE_COMMAND_` strings. The squashfs/gzip/ELF magic hits a naive scan reports
are coincidence: the ELF candidate at offset 391,219,820 has garbage in
`e_ident`. The decryption key lives in the camera.

**The iOS app is FairPlay-encrypted — also checked, also closed.** Pulled
2026-08-04 with `ipatool` (`com.insta360.oner` 2.30.1, 2.0 GB). The bundle holds
**38 Mach-O binaries; 37 carry `cryptid 1`**, including the main executable
(149 MB of encrypted `__TEXT`) and every framework worth reading —
`INSCameraSDK`, `INSCameraServiceSDK`, `INSAccessory`. The single unencrypted
binary contains no protocol strings. `strings` on the main binary returns 1.8M
lines of ciphertext noise and zero `PHONE_COMMAND_` or `.proto` hits. App Store
downloads are DRM-wrapped per-account; reading them needs a decrypted dump from
a jailbroken device, not a smarter parser.

**All three static routes are closed**, each by a different mechanism:

| Route           | Blocked by                                       |
| --------------- | ------------------------------------------------ |
| Android APK     | AppShield packer — bytecode decrypted at runtime |
| Camera firmware | Whole-image encryption, key held by the camera   |
| iOS IPA         | FairPlay DRM on 37 of 38 binaries                |

What is left is **runtime extraction**: let the software decrypt itself and read
the result out of memory. Either a real Android device (dump the dex once
AppShield has unpacked it — an emulator will not do, the app checks) or a
jailbroken iOS device (`frida-ios-dump` and friends). Both need hardware this
project does not have.

Names remain useful without numbers: they say which commands to look for, and
they retire "no readable lever" as an explanation for the parked features.

## Reproducing the extraction

```sh
# 1.6 GB bundle; the arm64 split and base.apk are what matter
unzip -o insta360.apkm split_config.arm64_v8a.apk base.apk -d bundle/
unzip -o bundle/base.apk 'classes*.dex' -d dex/

strings -a dex/classes.dex \
  | grep -oE "PHONE_COMMAND_[A-Z0-9_]+|CAMERA_NOTIFICATION_[A-Z0-9_]+|FACTORY_COMMAND_[A-Z0-9_]+" \
  | sort -u
```

The control protocol is **not** in a native library. `libOne.so`, which older
write-ups point at, no longer exists in this app; `libarvbmg.so` carries only
the media and editing half of the `insta360.messages` namespace. The control
protocol is Kotlin, in `classes.dex` (`Linsta360/messages/MessageCode;`).
