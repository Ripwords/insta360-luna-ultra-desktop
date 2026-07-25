# Changelog


## v0.2.3...master

[compare changes](https://github.com/Ripwords/luna-ultra-desktop/compare/v0.2.3...master)

### 🚀 Enhancements

- **camera:** Add the Leica and cinematic filter controls ([b7c7109](https://github.com/Ripwords/luna-ultra-desktop/commit/b7c7109))
- **camera:** Gate controls by what each mode actually supports ([b84da24](https://github.com/Ripwords/luna-ultra-desktop/commit/b84da24))
- **camera:** Rework the viewfinder and gate the settings panel ([94a701d](https://github.com/Ripwords/luna-ultra-desktop/commit/94a701d))
- **scripts:** Add the camera protocol calibration probe ([d3ae740](https://github.com/Ripwords/luna-ultra-desktop/commit/d3ae740))

### 🩹 Fixes

- **camera:** Correct protocol enums for firmware v1.0.238 ([6dd7551](https://github.com/Ripwords/luna-ultra-desktop/commit/6dd7551))
- **camera:** Read settings on arrival and after a colour-mode change ([4ba6735](https://github.com/Ripwords/luna-ultra-desktop/commit/4ba6735))

### 🏡 Chore

- Ignore .playwright-mcp ([15760d4](https://github.com/Ripwords/luna-ultra-desktop/commit/15760d4))

### ❤️ Contributors

- JJ <teohjjteoh@gmail.com>

## v0.2.2...feat/camera-control

[compare changes](https://github.com/Ripwords/luna-ultra-desktop/compare/v0.2.2...feat/camera-control)

### 🚀 Enhancements

- Load gallery thumbnails toward the viewport, opened item first ([f8b8fdb](https://github.com/Ripwords/luna-ultra-desktop/commit/f8b8fdb))

### ❤️ Contributors

- JJ <teohjjteoh@gmail.com>

## v0.2.1...master

[compare changes](https://github.com/Ripwords/luna-ultra-desktop/compare/v0.2.1...master)

### 🩹 Fixes

- List media via GET_FILE_LIST to support camera firmware 1.0.238 ([072f60c](https://github.com/Ripwords/luna-ultra-desktop/commit/072f60c))

### ❤️ Contributors

- JJ <teohjjteoh@gmail.com>

## v0.2.0...master

[compare changes](https://github.com/Ripwords/luna-ultra-desktop/compare/v0.2.0...master)

### 🩹 Fixes

- Retry the media library read while the camera authorizes HTTP ([61c007d](https://github.com/Ripwords/luna-ultra-desktop/commit/61c007d))

### 📖 Documentation

- Add camera control screenshot to README ([59d7582](https://github.com/Ripwords/luna-ultra-desktop/commit/59d7582))

### ❤️ Contributors

- JJ <teohjjteoh@gmail.com>

## v0.1.12...master

[compare changes](https://github.com/Ripwords/luna-ultra-desktop/compare/v0.1.12...master)

### 🚀 Enhancements

- Session LRU cache for camera images and RAW previews ([a082748](https://github.com/Ripwords/luna-ultra-desktop/commit/a082748))
- Add camera health failure counter ([b3a5db7](https://github.com/Ripwords/luna-ultra-desktop/commit/b3a5db7))
- Disconnect the camera after three failed requests ([335429c](https://github.com/Ripwords/luna-ultra-desktop/commit/335429c))
- Persist the camera host across launches ([a51a09e](https://github.com/Ripwords/luna-ultra-desktop/commit/a51a09e))
- Add a dedicated settings page ([f8b7e9c](https://github.com/Ripwords/luna-ultra-desktop/commit/f8b7e9c))
- Reduce the home page to connect and disconnect ([030676b](https://github.com/Ripwords/luna-ultra-desktop/commit/030676b))
- Annex-b parsing utilities for live view ([845f289](https://github.com/Ripwords/luna-ultra-desktop/commit/845f289))
- Surface UCD2 stream frame payloads ([345c338](https://github.com/Ripwords/luna-ultra-desktop/commit/345c338))
- Live view transport over a localhost stream server ([96eb20d](https://github.com/Ripwords/luna-ultra-desktop/commit/96eb20d))
- Live view client wrappers and composable ([b653dce](https://github.com/Ripwords/luna-ultra-desktop/commit/b653dce))
- Live view component on the connect page ([974dbf8](https://github.com/Ripwords/luna-ultra-desktop/commit/974dbf8))
- Protobuf wire-format codec ([793d96f](https://github.com/Ripwords/luna-ultra-desktop/commit/793d96f))
- Schema-driven protobuf message codec ([2308911](https://github.com/Ripwords/luna-ultra-desktop/commit/2308911))
- Allowlisted protobuf command passthrough ([08faa96](https://github.com/Ripwords/luna-ultra-desktop/commit/08faa96))
- Camera settings client and composable ([e9d4fca](https://github.com/Ripwords/luna-ultra-desktop/commit/e9d4fca))
- Pro camera settings page ([fd118d0](https://github.com/Ripwords/luna-ultra-desktop/commit/fd118d0))
- Verify settings writes by reading them back ([e6e5680](https://github.com/Ripwords/luna-ultra-desktop/commit/e6e5680))
- Manual ISO and shutter wheel with a pro camera page ([0026f93](https://github.com/Ripwords/luna-ultra-desktop/commit/0026f93))
- Capture controls and shooting modes ([a5b616b](https://github.com/Ripwords/luna-ultra-desktop/commit/a5b616b))
- Expand the settings panel to every confirmed option ([a2d884d](https://github.com/Ripwords/luna-ultra-desktop/commit/a2d884d))
- Camera exposure, white balance, and settings controls ([fe0ad43](https://github.com/Ripwords/luna-ultra-desktop/commit/fe0ad43))
- Immersive camera viewfinder with auto-start live preview ([6e44506](https://github.com/Ripwords/luna-ultra-desktop/commit/6e44506))

### 🩹 Fixes

- Center preview images instead of aligning them left ([305124d](https://github.com/Ripwords/luna-ultra-desktop/commit/305124d))
- **camera:** Disarm health detector on known disconnect event ([169a3c1](https://github.com/Ripwords/luna-ultra-desktop/commit/169a3c1))
- Announce camera state in the status chip link label ([ac78bd4](https://github.com/Ripwords/luna-ultra-desktop/commit/ac78bd4))
- Separate delete from download in the media preview ([a653bc5](https://github.com/Ripwords/luna-ultra-desktop/commit/a653bc5))
- Reveal day selection and use grid skeletons while loading ([d3d9e4d](https://github.com/Ripwords/luna-ultra-desktop/commit/d3d9e4d))
- Probe the camera before force-disconnecting on failures ([9a38eab](https://github.com/Ripwords/luna-ultra-desktop/commit/9a38eab))
- Lock the camera address while connected ([02d7c4a](https://github.com/Ripwords/luna-ultra-desktop/commit/02d7c4a))
- Stop preview shortcuts firing while the overflow menu is open ([7c7c571](https://github.com/Ripwords/luna-ultra-desktop/commit/7c7c571))
- Announce the gallery skeleton and constrain the colourway toggle ([a05a574](https://github.com/Ripwords/luna-ultra-desktop/commit/a05a574))
- Read live video from UCD2 media frames ([7186d16](https://github.com/Ripwords/luna-ultra-desktop/commit/7186d16))
- Assemble access units across read boundaries ([994514a](https://github.com/Ripwords/luna-ultra-desktop/commit/994514a))
- Add Camera to the sidebar navigation ([a7b3e40](https://github.com/Ripwords/luna-ultra-desktop/commit/a7b3e40))

### 💅 Refactors

- Extract WatermarkSettingsForm from the download modal ([233020d](https://github.com/Ripwords/luna-ultra-desktop/commit/233020d))

### 📖 Documentation

- Design for session media cache ([8a18b2f](https://github.com/Ripwords/luna-ultra-desktop/commit/8a18b2f))
- Spec settings page, camera auto-disconnect, and UI pass ([b7dfa6d](https://github.com/Ripwords/luna-ultra-desktop/commit/b7dfa6d))
- Narrow the UI section to concrete layout and button placement ([9bdf05f](https://github.com/Ripwords/luna-ultra-desktop/commit/9bdf05f))
- Add implementation plan for settings page and auto-disconnect ([6fecbee](https://github.com/Ripwords/luna-ultra-desktop/commit/6fecbee))
- Camera live view feasibility design ([028057d](https://github.com/Ripwords/luna-ultra-desktop/commit/028057d))
- Camera live view implementation plan ([a8b6089](https://github.com/Ripwords/luna-ultra-desktop/commit/a8b6089))
- Camera settings probe findings ([08132df](https://github.com/Ripwords/luna-ultra-desktop/commit/08132df))
- Camera settings implementation plan ([f03f12d](https://github.com/Ripwords/luna-ultra-desktop/commit/f03f12d))

### 🏡 Chore

- Add camera live view protocol probe ([c7a4565](https://github.com/Ripwords/luna-ultra-desktop/commit/c7a4565))
- Add read-only camera settings probe ([d8ad42b](https://github.com/Ripwords/luna-ultra-desktop/commit/d8ad42b))
- Drop unused import in settings probe ([738484d](https://github.com/Ripwords/luna-ultra-desktop/commit/738484d))
- Add feature flags for in-development camera features ([cb176f0](https://github.com/Ripwords/luna-ultra-desktop/commit/cb176f0))
- Describe Downloads folder access for the macOS TCC prompt ([7a54e10](https://github.com/Ripwords/luna-ultra-desktop/commit/7a54e10))

### ❤️ Contributors

- JJ <teohjjteoh@gmail.com>

## v0.1.11...master

[compare changes](https://github.com/Ripwords/luna-ultra-desktop/compare/v0.1.11...master)

### 🚀 Enhancements

- Sibling-JPG thumbnails for RAW+JPEG pairs; retry RAW downloads ([65cf719](https://github.com/Ripwords/luna-ultra-desktop/commit/65cf719))

### ❤️ Contributors

- JJ <teohjjteoh@gmail.com>

## v0.1.10...master

[compare changes](https://github.com/Ripwords/luna-ultra-desktop/compare/v0.1.10...master)

### 🩹 Fixes

- Faster thumbnail batches, RAW decode hardening, working space toggle ([4146989](https://github.com/Ripwords/luna-ultra-desktop/commit/4146989))

### ❤️ Contributors

- JJ <teohjjteoh@gmail.com>

## v0.1.9...master

[compare changes](https://github.com/Ripwords/luna-ultra-desktop/compare/v0.1.9...master)

### 🩹 Fixes

- Restore direct-src video thumbnails; space toggles playback ([9f6b4a4](https://github.com/Ripwords/luna-ultra-desktop/commit/9f6b4a4))

### ❤️ Contributors

- JJ <teohjjteoh@gmail.com>

## v0.1.8...master

[compare changes](https://github.com/Ripwords/luna-ultra-desktop/compare/v0.1.8...master)

### 🩹 Fixes

- Download full LRV for video thumbnails so they actually decode ([ea0671f](https://github.com/Ripwords/luna-ultra-desktop/commit/ea0671f))

### ❤️ Contributors

- JJ <teohjjteoh@gmail.com>

## v0.1.7...master

[compare changes](https://github.com/Ripwords/luna-ultra-desktop/compare/v0.1.7...master)

### 🩹 Fixes

- Cap camera HTTP concurrency to stop saturating the camera ([eb4b9b1](https://github.com/Ripwords/luna-ultra-desktop/commit/eb4b9b1))

### ❤️ Contributors

- JJ <teohjjteoh@gmail.com>

## v0.1.6...master

[compare changes](https://github.com/Ripwords/luna-ultra-desktop/compare/v0.1.6...master)

### 🩹 Fixes

- Load video thumbnails through the HTTP bridge as local blobs ([218a0cf](https://github.com/Ripwords/luna-ultra-desktop/commit/218a0cf))

### ❤️ Contributors

- JJ <teohjjteoh@gmail.com>

## v0.1.5...master

[compare changes](https://github.com/Ripwords/luna-ultra-desktop/compare/v0.1.5...master)

### 🩹 Fixes

- Robust RAW decode, Escape to close preview, video thumb stall guard ([33d83bf](https://github.com/Ripwords/luna-ultra-desktop/commit/33d83bf))

### ❤️ Contributors

- JJ <teohjjteoh@gmail.com>

## v0.1.4...master

[compare changes](https://github.com/Ripwords/luna-ultra-desktop/compare/v0.1.4...master)

### 🩹 Fixes

- Stream DNG download with progress; exclude 200MP stitched pano ([b0bd4f8](https://github.com/Ripwords/luna-ultra-desktop/commit/b0bd4f8))

### 📖 Documentation

- **changelog:** Tidy v0.1.4 section ([aa802de](https://github.com/Ripwords/luna-ultra-desktop/commit/aa802de))

### ❤️ Contributors

- JJ <teohjjteoh@gmail.com>

## v0.1.4

[compare changes](https://github.com/Ripwords/luna-ultra-desktop/compare/v0.1.2...v0.1.4)

### 🩹 Fixes

- Render DNG preview by decoding raw Bayer data ([0de1be0](https://github.com/Ripwords/luna-ultra-desktop/commit/0de1be0))
- Detect 360 photos by 2:1 aspect ratio ([62169fe](https://github.com/Ripwords/luna-ultra-desktop/commit/62169fe))

### ❤️ Contributors

- JJ <teohjjteoh@gmail.com>

## v0.1.1...master

[compare changes](https://github.com/Ripwords/luna-ultra-desktop/compare/v0.1.1...master)

### 🚀 Enhancements

- Preview RAW (DNG) via embedded JPEG extraction ([6865404](https://github.com/Ripwords/luna-ultra-desktop/commit/6865404))

### 🩹 Fixes

- Enable 360 pano drag in WKWebView ([0f65ad9](https://github.com/Ripwords/luna-ultra-desktop/commit/0f65ad9))

### ❤️ Contributors

- JJ <teohjjteoh@gmail.com>

## v0.1.0...master

[compare changes](https://github.com/Ripwords/luna-ultra-desktop/compare/v0.1.0...master)

### 🚀 Enhancements

- 360/pano viewer, storage filter, and RAW/format handling ([b5f56dc](https://github.com/Ripwords/luna-ultra-desktop/commit/b5f56dc))

### 🏡 Chore

- Support explicit version in release script ([7f11374](https://github.com/Ripwords/luna-ultra-desktop/commit/7f11374))

### ❤️ Contributors

- JJ <teohjjteoh@gmail.com>

