# Changelog

## v0.3.0...master

[compare changes](https://github.com/Ripwords/insta360-luna-ultra-desktop/compare/v0.3.0...master)

### 🚀 Enhancements

- **docs): add feature map detailing implementation status and WIP features fix(docs:** Update README for clarity on camera control features chore: update .gitignore to include .claude ([08bc1bc](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/08bc1bc))
- **transport:** Add swappable CameraTransport registry ([9228054](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/9228054))
- **docs:** Scaffold the docs site as a layer of the desktop app ([179e0fe](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/179e0fe))
- **docs:** Add docs chrome and confine layer routes to /demo ([0477180](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/0477180))
- **docs:** Add the documentation pages and content collection ([d28fbfc](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/d28fbfc))
- **docs:** Add sitemap, canonicals, OG images and structured data ([5e24eb4](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/5e24eb4))
- **demo:** Extract AppShell and add the demo layout ([3319561](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/3319561))
- **demo:** Generate media fixtures with ffmpeg ([850c354](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/850c354))
- **demo:** Add the mock camera transport ([74cb936](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/74cb936))
- **demo:** Serve a decimated camera scan and scope the demo remount ([0b5f10a](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/0b5f10a))
- **demo:** Answer the protobuf command channel ([e8676e6](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/e8676e6))
- **demo:** Drive live view from an Annex-B fixture ([e8e7000](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/e8e7000))
- **demo:** Embed live demos inline in the documentation ([de5c859](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/de5c859))
- **docs:** Serve the original hi-fi STL scan instead of a decimated copy ([7d7eefd](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/7d7eefd))
- **demo:** Render /demo/* inside a macOS window on top-level visits ([f2d2bc3](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/f2d2bc3))
- **docs:** Derive site icons from app-icon.png and balance the header ([f88b693](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/f88b693))
- **docs:** Add content search, deferred until first open ([5b98fd7](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/5b98fd7))
- **downloads:** Show RAW previews derived from the downloaded bytes ([d8d358e](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/d8d358e))
- **camera:** Add a live histogram overlay to the viewfinder ([06abc69](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/06abc69))

### 🔥 Performance

- **raw:** Decode Bayer previews with lookup tables ([a2cff28](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/a2cff28))
- **live-view:** Split NAL units without per-unit allocation ([f85035c](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/f85035c))
- **3d:** Gate the model render loop on visibility ([b65810c](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/b65810c))
- **gallery:** Virtualize the media grid ([64e90e6](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/64e90e6))
- **gallery:** Cache thumbnail priority scores per frame ([0e07384](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/0e07384))
- **downloads:** Render the watermark in a worker ([cd6dbaa](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/cd6dbaa))
- **docs:** Skip fixture regeneration when nothing changed ([a3e7464](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/a3e7464))

### 🩹 Fixes

- **deps:** Pin typescript back to ^5.9.0 for vue-tsc compat ([884da9a](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/884da9a))
- **test:** Reset camera-host with reinit, not delete, before each useCamera test ([74c24af](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/74c24af))
- **docs:** Pin hoisted linker, fix site.url, restore inherited routes ([7944540](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/7944540))
- **docs:** Synthesize /demo route and redirect layer's hardcoded links ([5361b0e](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/5361b0e))
- **docs:** Make redirect targets base-absolute ([b4d6f9d](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/b4d6f9d))
- **docs:** Correct base path for repo rename and fix trailing-slash hydration ([4e5c35b](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/4e5c35b))
- **docs:** Stop demo in-app navigation from doubling the base path ([467cae0](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/467cae0))
- **docs:** Correct SEO metadata — empty JSON-LD, doubled title, trailing-slash canonicals ([463bb1d](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/463bb1d))
- **docs:** Replace og.png placeholder with a real 1200x630 image ([0e3df30](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/0e3df30))
- **docs:** Strip the dead 59 MB STL from the generated docs site ([99458c9](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/99458c9))
- **docs:** Declare @nuxt/kit as an explicit dependency ([5c36cd8](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/5c36cd8))
- **docs:** Add favicon link, remove dead config, fix stale comments ([793f15d](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/793f15d))
- **demo:** Give LRV proxies a real .lrv extension ([50eba5c](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/50eba5c))
- **assets:** Resolve model and watermark URLs against the app base URL ([e5c44bb](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/e5c44bb))
- **demo:** Pace the live-view fixture with a service worker ([1d3d1cf](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/1d3d1cf))
- **demo:** Auto-connect embeds whose preset seeds a connected camera ([2ed66cb](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/2ed66cb))
- **demo:** Clear app controls from the disclosure banner, add a back-to-docs link ([2df59a5](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/2df59a5))
- **demo:** Correct macOS window-chrome radius and dark-mode hairline ([d254665](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/d254665))
- **demo:** Stop DashboardPanel's min-h-svh clipping camera's shutter ([1a2c827](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/1a2c827))
- **downloads:** Record the transferred byte count so sizes aren't 0 B ([ee99a2c](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/ee99a2c))
- **downloads:** Stop promising a watermark on RAW files ([8434d5f](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/8434d5f))

### 💅 Refactors

- **camera:** Read the camera through the transport registry ([e215212](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/e215212))
- **camera:** Route gallery and live view through the transport ([5a51eda](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/5a51eda))
- **camera:** Route every camera call through the transport ([0e87304](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/0e87304))
- **transport:** Rename useCameraTransport to getCameraTransport ([5049c42](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/5049c42))

### 📖 Documentation

- Update feature status and descriptions in FEATURES.md ([51d1b27](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/51d1b27))
- Add design spec for docs site and live component demo ([df60e0e](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/df60e0e))
- Unify README download badges into one graphite row ([869cfe9](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/869cfe9))
- Link download badges straight to the latest installers ([e632874](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/e632874))
- Add implementation plan for transport seam and camera layer ([d3bd5e1](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/d3bd5e1))
- Refresh plan against the perf wave ([4f2a27a](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/4f2a27a))
- Cancel the layers/camera move, extend the repo root instead ([d97e50e](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/d97e50e))
- Correct the plan goal after the layer move was cancelled ([55bb11f](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/55bb11f))
- **transport:** Document SSR lifetime and health-reporting contract ([dcec175](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/dcec175))
- Describe the transport seam and the two test projects ([93a1e32](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/93a1e32))
- Add implementation plan for the docs site ([a7da714](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/a7da714))
- Correct the base path and add a contribution-guide task ([fd453b6](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/fd453b6))
- Update spec URLs for the repo rename ([59e9247](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/59e9247))
- Add the interactive demo implementation plan ([f82e4b3](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/f82e4b3))
- Add a contribution guide and GitHub issue/PR templates ([f84247a](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/f84247a))
- Link the docs site from README ([dcbc60f](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/dcbc60f))
- Specify macOS window chrome for the demo embeds ([10f853b](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/10f853b))
- Commit Task 7 addendum to the interactive-demo plan ([0f1f3f2](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/0f1f3f2))

### 📦 Build

- Stamp the README download links at release time ([556aa81](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/556aa81))

### 🏡 Chore

- Code cleanup and convention enforcement ([2b9b8dc](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/2b9b8dc))
- **lint:** Enforce the transport seam with no-restricted-imports ([09a26c3](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/09a26c3))
- **demo:** Prune unused mock presets ([827eef2](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/827eef2))

### ✅ Tests

- Add Nuxt test environment for composables ([7596007](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/7596007))
- **nuxt:** Reinitialize cleared state instead of deleting it ([946e81c](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/946e81c))

### 🎨 Styles

- **docs:** Run oxfmt on interactive-demo plan ([4efc589](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/4efc589))

### 🤖 CI

- Bump actions/checkout to v5 ([bc1fe14](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/bc1fe14))
- Bump actions/github-script to v8 ([4055501](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/4055501))
- Split unit-test step into node and nuxt projects ([7da6012](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/7da6012))
- Build and deploy the docs site to GitHub Pages ([abc000b](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/abc000b))
- **docs:** Drop redundant base-url env, add bunfig trigger, bump checkout ([70afd66](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/70afd66))
- **docs:** Install ffmpeg before the docs build ([aee680e](https://github.com/Ripwords/insta360-luna-ultra-desktop/commit/aee680e))

### ❤️ Contributors

- JJ <teohjjteoh@gmail.com>

## v0.2.4...master

[compare changes](https://github.com/Ripwords/luna-ultra-desktop/compare/v0.2.4...master)

### 🚀 Enhancements

- **scripts:** Watch the camera live and decode captures ([b40883b](https://github.com/Ripwords/luna-ultra-desktop/commit/b40883b))
- **camera:** Zoom from 1x to 12x ([40ae746](https://github.com/Ripwords/luna-ultra-desktop/commit/40ae746))
- **camera:** Choose resolution, framerate and aspect separately ([ed8c50c](https://github.com/Ripwords/luna-ultra-desktop/commit/ed8c50c))
- **camera:** Drop the pro-bar pickers out of their own chips ([587418d](https://github.com/Ripwords/luna-ultra-desktop/commit/587418d))

### 🩹 Fixes

- **camera:** Add the resolutions and fields this firmware really has ([b5527f7](https://github.com/Ripwords/luna-ultra-desktop/commit/b5527f7))
- **camera:** Apply filters while the camera is in i-Log ([da6ac05](https://github.com/Ripwords/luna-ultra-desktop/commit/da6ac05))

### ❤️ Contributors

- JJ <teohjjteoh@gmail.com>

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
