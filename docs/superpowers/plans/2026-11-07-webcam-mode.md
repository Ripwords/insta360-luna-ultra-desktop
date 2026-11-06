# Webcam Mode (Stream to OBS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the preview-stream bugs and add a Webcam mode that serves the camera's live preview as MPEG-TS on a fixed localhost URL that OBS plays, on macOS, Windows and Linux alike.

**Architecture:**
- Rust gets a session-independent `Relay`. A pump task feeds it from the camera session. The relay splits the H.265/H.264 elementary stream into access units, caches the current GOP, and broadcasts it to clients.
- `LiveViewState` counts two consumers, `Viewfinder` and `Webcam`. It sends START when the first consumer arrives and STOP when the last one leaves.
- The viewfinder endpoint serves raw Annex-B. The webcam endpoint (`127.0.0.1:49283/webcam.ts`) gives every client its own MPEG-TS muxer.
- The frontend gets a `useWebcam` composable, a panel on the camera page, and an HTTP media hold in the gallery and downloads.

**Tech Stack:** Rust (tokio, Tauri 2), Nuxt 4 + Nuxt UI v4, Vitest (node and nuxt configs), ffmpeg/ffprobe for fixtures and container checks.

**Spec:** `docs/superpowers/specs/2026-11-07-webcam-mode-design.md`

## Global Constraints

- No new Rust crates. The muxer, NAL parsing and SPS parsing are hand-written.
- Webcam port: `49283`. If binding fails, fall back to `127.0.0.1:0` and report the actual port. Bind to `127.0.0.1` only.
- Path `/webcam.ts`, `Content-Type: video/mp2t`.
- TS stream types: `0x24` for H.265, `0x1B` for H.264. PAT/PMT go out every 100 ms of PTS and before every keyframe. PTS = DTS from the arrival time on a 90 kHz clock that starts at relay creation.
- GOP cache cap: 16 MB. Past the cap, drop the cache until the next keyframe.
- Stall: 12 s without video. Recovery: at most 2 STOP/START cycles, 30 s apart. 30 s of steady video resets the budget.
- Keepalive: skip the status/options queries while video arrived within the last 12 s. Control-socket writes time out after 3 s.
- Copy (verbatim):
  - "The camera stopped sending video. Its screen may have gone to sleep. Tap the camera's screen to wake it."
  - "Webcam mode is on. The camera can't stream and transfer files at the same time."
  - "Finish or cancel your downloads first."
- Project rules: TDD; `bun run fmt` and `bun run lint` clean; Vue prop shorthand, `useTemplateRef`, destructured prop defaults; readable text ≥ `text-sm`; Nuxt UI controls `size="md"` or default; no `window.confirm`; the manual is updated in the same change.
- Commits: Conventional Commits; stage explicit paths, never `git add -A`; never pass `-c user.email`.

## Review Focus

1. **OBS joins mid-GOP or right after a mode switch.** It must get parameter sets plus a keyframe first, never P-frames. Pinned by the Task 5 test `subscriber_bootstrap_starts_at_keyframe_with_current_params` and the Task 6 test `ffmpeg_decodes_mode_switch_without_errors`.
2. **The camera reconnects while OBS stays connected.** The relay outlives the session. OBS's socket stays open and the picture resumes after the next keyframe. Pinned by Task 7 `pump_switches_to_new_session_without_closing_clients`.
3. **One UCD2 frame split across TCP reads at any offset**, including a trailing `U`/`UC`/`UCD`. Pinned by Task 1 `drain_frames_is_split_invariant`.
4. **A slow client** (OBS paused, or a viewfinder tab throttled). It is closed, never fed a gapped stream, and the camera session is unaffected. Pinned by Task 7 `lagging_client_is_closed`.
5. **Webcam mode on while the gallery is open.** No HTTP media request may reach the camera. Pinned by Task 10 `held queue runs nothing until released`, and the downloads button is disabled.

---

### Task 1: UCD2 framing survives any read split

**Files:**
- Modify: `src-tauri/src/luna.rs:193-247` (`drain_frames`) and its test module

**Interfaces:**
- Produces: no signature change. `drain_frames(&mut Vec<u8>) -> Vec<Frame>` keeps a trailing prefix of `UCD2_MAGIC` (up to 3 bytes) instead of clearing it.

- [ ] **Step 1: Write the failing tests** in `luna.rs` `mod tests`:
  - `drain_frames_keeps_partial_magic`: buffer = `b"garbageUC"`. After `drain_frames`, buffer == `b"UC"` and no frames.
  - `drain_frames_is_split_invariant`: build a stream of a FILE frame, a STREAM hello (`build_stream_hello`) and a MEDIA frame (substream `0x20`, 9-byte media header, then 100 payload bytes), using `build_ucd2` / `build_file_command`. For every split offset `k` in `0..stream.len()`, feed `stream[..k]` and then `stream[k..]` into one buffer, calling `drain_frames` after each push. Assert the collected frames match the single-push result: same variants, same media data, same file `request_id`. Derive `PartialEq` on `Frame`/`RawResponse` if needed.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml --lib drain_frames`. Expected: FAIL (`partial magic` leaves an empty buffer).
- [ ] **Step 3: Implement.** When no full magic is found, keep the longest suffix of the buffer (at most 3 bytes) that is a prefix of `UCD2_MAGIC`, and drain everything before it.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `fix(liveview): keep a partial UCD2 header across socket reads`.

### Task 2: Keepalive that trusts video, bounded writes, no evicting a newer session

**Files:**
- Modify: `src-tauri/src/luna.rs` (constants near line 51, `Session`, the `open_session` reader and keepalive)

**Interfaces:**
- Produces:
  - `const VIDEO_ALIVE_WINDOW: Duration = Duration::from_secs(12)`
  - `const WRITE_TIMEOUT: Duration = Duration::from_secs(3)`
  - `fn video_recent(last_video: Option<Instant>, now: Instant) -> bool`
  - `Session.last_video: StdMutex<Option<Instant>>`, set by the reader on every video MEDIA frame
  - `pub(crate) fn Session::last_video(&self) -> Option<Instant>`, which Task 8 uses for stall detection
  - `pub(crate) fn same_session(a: &Arc<Session>, b: &Arc<Session>) -> bool` (`Arc::ptr_eq`)

- [ ] **Step 1: Write the failing tests:**
  - `video_recent_requires_video_inside_window`: `None` → false; `now - 6s` → true; `now - 12s` → false.
  - `write_times_out_on_a_wedged_socket`: a tokio test with a `TcpListener` that accepts and never reads. Fill the socket by writing 64 MB through `Session::write`. Within `WRITE_TIMEOUT + 1s`, assert `Err` containing `"timed out"`. Build the `Session` with a small test-only constructor in `mod tests` that wraps `stream.into_split()`.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml --lib -- video_recent write_times_out`. Expected: FAIL to compile.
- [ ] **Step 3: Implement:**
  - Wrap `write_all` in `Session::write` with `tokio::time::timeout(WRITE_TIMEOUT, …)` → `"camera write timed out"`.
  - In the keepalive tick, always send the hello. Run the two queries only when `!video_recent(session.last_video(), Instant::now())`.
  - On the failure path, replace `ka_state.lock().await.take()` with: take only if the stored session is the same one (`same_session`); otherwise just break without emitting.
- [ ] **Step 4: Run** `cargo test --manifest-path src-tauri/Cargo.toml --lib`. Expected: PASS (all existing tests too).
- [ ] **Step 5: Commit** `fix(connection): skip keepalive queries while video flows and bound socket writes`.

### Task 3: Health detector staleness by revision

**Files:**
- Modify: `app/utils/cameraHealth.ts`
- Test: `tests/cameraHealth.test.ts`

**Interfaces:**
- Produces: no API change. Internally, `let revision = 0`, incremented by `armCameraHealth` and `disarmCameraHealth`. `runProbe` captures it and bails out if it changed.

- [ ] **Step 1: Write the failing test** `re-arming with the same callback discards a pending probe verdict`:
  - Arm with `onDead` and a probe that returns a deferred promise.
  - Report `FAILURE_THRESHOLD` failures, so the probe is open.
  - Call `armCameraHealth(onDead, sameProbe)` again, resolve the first probe with `false`, and await microtasks.
  - Expect `onDead` not called.
- [ ] **Step 2: Run** `bunx vitest run tests/cameraHealth.test.ts`. Expected: FAIL (`onDead` called once).
- [ ] **Step 3: Implement** the revision counter, replacing the `onDeadCallback !== callback` check.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `fix(health): ignore probe verdicts from a previous arming`.

### Task 4: NAL parsing, access units and SPS dimensions (Rust)

**Files:**
- Create: `scripts/make-webcam-fixtures.sh`
- Create: `src-tauri/tests/fixtures/` with `hevc-idr.h265`, `hevc-cra-aud.h265`, `hevc-slices.h265`, `hevc-switch.h265`, `h264-idr.h264`
- Create: `src-tauri/src/webcam/mod.rs`, `src-tauri/src/webcam/nal.rs`
- Modify: `src-tauri/src/lib.rs` (`mod webcam;`)

**Interfaces:**
- Produces (`webcam::nal`):
  - `pub enum Codec { H264, H265 }`
  - `pub struct AccessUnit { pub data: Vec<u8> /* Annex-B, 4-byte start codes */, pub keyframe: bool, pub params: Option<ParamSets>, pub pts90k: u64 }`
  - `pub struct ParamSets { pub codec: Codec, pub nals: Vec<Vec<u8>> /* VPS,SPS,PPS or SPS,PPS, without start codes */ }`. It derives `PartialEq` and `Clone`.
  - `pub struct AccessUnitAssembler`, with `new()` and `push(&mut self, chunk: &[u8], pts90k: u64) -> Vec<AccessUnit>`. It is incremental: it carries partial NALs and an open picture across calls. An AU closes when the next AU begins: at an AUD, a VPS/SPS/PPS (or H.264 SPS/PPS/AUD), or a VCL NAL whose `first_slice_segment_in_pic_flag` (H.264: `first_mb_in_slice == 0`) is set. Codec detection matches `app/utils/annexB.ts::detectCodec`. `params` is `Some` on every AU that carried parameter sets in-band.
  - `pub fn hevc_dimensions(sps: &[u8]) -> Option<(u32, u32)>`. It removes emulation prevention bytes, parses `profile_tier_level` for any `max_sub_layers_minus1`, then reads `pic_width/height_in_luma_samples` and applies the conformance window.

- [ ] **Step 1: Write the fixture script and generate the fixtures.** All fixtures use `ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30 -t 2` (2 s, small):
  - `hevc-idr`: `-c:v libx265 -x265-params keyint=30:open-gop=0:repeat-headers=1`
  - `hevc-cra-aud`: `open-gop=1:aud=1:repeat-headers=1`
  - `hevc-slices`: `slices=4`
  - `hevc-switch`: concatenate a 1280×720 and a 720×1280 clip at the Annex-B level (`cat`)
  - `h264-idr`: `libx264 -bsf:v h264_mp4toannexb`
  - Add a header comment with the exact commands. Run it, and check that each file is under 300 KB.
- [ ] **Step 2: Write the failing tests** in `nal.rs`. Fixtures load with `include_bytes!("../../tests/fixtures/…")`.
  - `assembles_one_au_per_frame`: for each 2 s fixture at 30 fps, expect 60 AUs. Feed the fixture in 1000-byte chunks and in one chunk; the results must be identical.
  - `marks_idr_and_cra_as_keyframes`: `hevc-idr` and `hevc-cra-aud` each have ≥ 2 keyframes, and AU 0 is a keyframe carrying `params`.
  - `multi_slice_pictures_stay_one_au`: `hevc-slices` gives 60 AUs.
  - `reads_hevc_dimensions`: the first SPS in `hevc-idr` gives `(1280, 720)`. In `hevc-switch`, the SPS after the switch gives `(720, 1280)`.
  - `detects_h264`: `h264-idr` → `Codec::H264`, with 60 AUs.
- [ ] **Step 3: Run** `cargo test --manifest-path src-tauri/Cargo.toml --lib webcam::nal`. Expected: FAIL to compile.
- [ ] **Step 4: Implement** `nal.rs` to the interface above.
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Commit** the script, the fixtures, `webcam/mod.rs`, `webcam/nal.rs` and `lib.rs` with `feat(webcam): split the preview stream into access units`.

### Task 5: Relay with GOP cache and late-join bootstrap

**Files:**
- Create: `src-tauri/src/webcam/relay.rs`

**Interfaces:**
- Consumes: `AccessUnit`, `ParamSets`, `AccessUnitAssembler` (Task 4).
- Produces:
  - `pub struct Relay` (held in an `Arc`), with `pub fn new() -> Arc<Relay>`
  - `pub fn push_chunk(&self, chunk: &[u8], now: Instant)` assembles AUs (pts from `now` minus relay creation, at 90 kHz), updates the cache and broadcasts each AU.
  - `pub fn subscribe(&self) -> Subscription`, with `pub struct Subscription { pub bootstrap: Vec<Arc<AccessUnit>>, pub live: broadcast::Receiver<Arc<AccessUnit>> }`. It is taken under the same lock as the cache update, so no AU is missed or duplicated.
  - `pub fn params(&self) -> Option<ParamSets>` and `pub fn last_video(&self) -> Option<Instant>`
  - `pub fn reset_assembler(&self)` drops partial data when the session changes. Cache and clients stay.
  - The broadcast capacity is 256 AUs.
- Cache rules:
  - A keyframe starts a new cache.
  - Non-key AUs append while the cache is open.
  - Over 16 MB, the cache is cleared and stays closed until the next keyframe.
  - New parameter sets that differ from the current ones clear the cache. The next keyframe opens it again.
  - The bootstrap is the current params (as one synthetic AU, flagged `keyframe: false`, `pts90k` equal to the first cached AU) followed by the cache. It is empty if the cache is closed.

- [ ] **Step 1: Write the failing tests** (fed from `hevc-idr` / `hevc-switch` chunks, with increasing `Instant`s):
  - `subscriber_bootstrap_starts_at_keyframe_with_current_params`: subscribe mid-GOP. `bootstrap[0]` holds the params, `bootstrap[1].keyframe`, and the bootstrap length is 1 + AUs since the last keyframe. In `hevc-switch` after the switch, the bootstrap params decode to `(720, 1280)` via `hevc_dimensions`.
  - `live_follows_bootstrap_without_gap_or_duplicate`: concatenate bootstrap + live `pts90k` values. They are strictly increasing and their count matches the AUs pushed.
  - `cache_cap_closes_until_next_keyframe`: push a synthetic keyframe AU, then non-key AUs totalling > 16 MB. The bootstrap is empty. After another keyframe it holds 2 entries.
  - `pts_follows_arrival_time`: chunks pushed 40 ms apart give AU `pts90k` deltas of 3600.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml --lib webcam::relay`. Expected: FAIL.
- [ ] **Step 3: Implement** `relay.rs` to the interface above.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(webcam): relay with GOP cache so late joiners start clean`.

### Task 6: MPEG-TS muxer

**Files:**
- Create: `src-tauri/src/webcam/ts.rs`
- Modify: `.github/workflows/ci.yml` (add `ffmpeg` to the `apt-get install` line of the `rust` job)

**Interfaces:**
- Consumes: `AccessUnit`, `Codec` (Task 4).
- Produces:
  - `pub struct TsMuxer`, with `pub fn new(codec: Codec) -> Self`
  - `pub fn mux(&mut self, au: &AccessUnit) -> Vec<u8>` returns whole 188-byte packets.
  - Fixed values:
    - PAT program 1 → PMT PID `0x1000`; video PID `0x0100`, which is also the PCR PID; PES `stream_id` `0xE0`; `PES_packet_length` 0.
    - The first packet of each PES carries an adaptation field with PCR = pts × 300 and, on keyframes, `random_access_indicator`. Stuff the last packet through the adaptation field.
    - Continuity counters per PID, mod 16. CRC32/MPEG-2 on PSI.
  - A synthetic params-only AU (bootstrap entry 0) is prepended to the next AU, not muxed alone.
  - `pub fn stream_type(codec: Codec) -> u8` returns `0x24` or `0x1B`.

- [ ] **Step 1: Write the failing tests:**
  - `packets_are_188_with_sync_bytes`
  - `continuity_counters_increment_per_pid`
  - `pat_pmt_before_every_keyframe_and_every_100ms`: from `hevc-idr` through `AccessUnitAssembler` at 30 fps, check PAT and PMT precede each keyframe PES and appear at least once per 9000 pts ticks.
  - `pmt_declares_stream_type`: `0x24` for H.265, `0x1B` for H.264.
  - `pes_carries_pts_and_pcr`: decode the PTS from the PES header and the PCR from the adaptation field. They equal `au.pts90k` and `au.pts90k * 300`.
  - `ffmpeg_decodes_fixture` and `ffmpeg_decodes_mode_switch_without_errors`:
    - Mux `hevc-idr` and `hevc-switch` to a temp file.
    - Run `ffprobe -v error -show_entries stream=codec_name,width,height -of csv=p=0`. Expect `hevc,1280,720`; the switch fixture's second half is checked by decoding.
    - Run `ffmpeg -v error -i <file> -f null -` and expect empty stderr.
    - If `ffprobe` is not on PATH, print `skipping: ffprobe not installed` and return. CI installs it, so it runs there.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml --lib webcam::ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `ts.rs` to the interface above.
- [ ] **Step 4: Run** the same command. Expected: PASS, with both ffmpeg tests executing locally (ffmpeg is at `/opt/homebrew/bin`).
- [ ] **Step 5: Commit** `feat(webcam): mux access units into MPEG-TS`.

### Task 7: Shared preview ownership and the viewfinder on the relay

**Files:**
- Modify: `src-tauri/src/liveview.rs` (rewrite the state; keep `build_start_live_stream_body` and its test)
- Modify: `src-tauri/src/lib.rs` (managed state unchanged in name)

**Interfaces:**
- Consumes: `Relay` (Task 5), `same_session`/`Session::last_video` (Task 2).
- Produces:
  - `#[derive(Clone, Copy, PartialEq, Eq, Hash)] pub enum Consumer { Viewfinder, Webcam }`
  - `pub struct LiveViewState { inner: Mutex<Preview> }`, holding:
    - `relay: Arc<Relay>`, created once and living for the app's lifetime
    - `consumers: HashSet<Consumer>`
    - `session: Option<Arc<Session>>`, the session START was sent on
    - `pump: Option<JoinHandle<()>>`
    - `viewfinder: Option<(u16, JoinHandle<()>)>`
  - `pub(crate) async fn acquire(&self, consumer: Consumer, session: Arc<Session>) -> Result<(), String>`:
    - If the stored session differs (`!same_session`), abort the pump, `relay.reset_assembler()`, start a new pump from `session.subscribe_stream()` into `relay.push_chunk`, and send START.
    - Otherwise, send START only if `consumers` was empty.
  - `pub(crate) async fn release(&self, consumer: Consumer)` sends STOP and aborts the pump when `consumers` becomes empty.
  - `pub(crate) async fn relay(&self) -> Arc<Relay>`
  - `async fn serve_annexb(listener: TcpListener, relay: Arc<Relay>)` writes the response head, then the bootstrap AUs' `data` (params AU first), then live AUs. On `RecvError::Lagged`, it closes the socket.
  - Tauri commands keep their names and shapes:
    - `luna_liveview_start` = acquire `Viewfinder` + ensure the viewfinder listener; returns `LiveViewInfo`.
    - `luna_liveview_stop` = release `Viewfinder` + abort the viewfinder listener.
    - `luna_liveview_stats` reads counters fed by the pump.
  - The `Stats` recorder task is removed; the pump counts.
- Pump: `Lagged` on the session receiver → `relay.reset_assembler()` and continue (the relay resyncs at the next AU start). `Closed` → end.

- [ ] **Step 1: Write the failing tests** (tokio tests on a plain `Relay` + `serve_annexb`, no camera):
  - `viewfinder_client_gets_params_then_keyframe`: push half of `hevc-idr`, connect a `TcpStream`, and read until 2 NAL start codes are past the head. The first NAL type is VPS (32).
  - `lagging_client_is_closed`: connect, don't read, and push 2 000 synthetic 64 KB AUs. Then read to EOF and assert it ends within 5 s, with no hang.
  - `pump_switches_to_new_session_without_closing_clients`: covered at the relay level. Connect a client, call `reset_assembler`, push `hevc-idr` again, and assert the client receives a keyframe AU after the reset and the socket is still open.
  - Consumer accounting as a pure helper, `fn transition(consumers: &HashSet<Consumer>, change: Change) -> (HashSet<Consumer>, Option<Command>)`, with `Command::{Start, Stop}`. Cases:
    - first acquire → `Start`
    - second acquire → `None`
    - release one of two → `None`
    - release last → `Stop`
    - release an absent consumer → `None`
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml --lib liveview`. Expected: FAIL.
- [ ] **Step 3: Implement** the new `LiveViewState` and commands to the interface above.
- [ ] **Step 4: Run** `cargo test --manifest-path src-tauri/Cargo.toml --lib`, then `bun run test`. Expected: PASS. The frontend is unchanged because the command shapes are unchanged.
- [ ] **Step 5: Commit** `refactor(liveview): share one camera preview between consumers through the relay`.

### Task 8: Webcam server, stall recovery and commands

**Files:**
- Create: `src-tauri/src/webcam/server.rs`, `src-tauri/src/webcam/stall.rs`
- Modify: `src-tauri/src/webcam/mod.rs` (state and commands), `src-tauri/src/lib.rs` (manage `WebcamState`, register commands)

**Interfaces:**
- Consumes: `LiveViewState::acquire/release/relay`, `Consumer::Webcam` (Task 7); `TsMuxer` (Task 6); `hevc_dimensions` (Task 4).
- Produces:
  - `pub const WEBCAM_PORT: u16 = 49283`
  - `async fn bind_webcam() -> std::io::Result<TcpListener>` tries `127.0.0.1:49283`, then `127.0.0.1:0`.
  - `async fn serve_ts(listener, relay)`:
    - `GET /webcam.ts` → `200` with `Content-Type: video/mp2t`, `Cache-Control: no-store`, `Connection: close`, then the bootstrap and live AUs through a per-client `TsMuxer`.
    - Any other path → `404`.
    - `Lagged` → close.
  - In `stall.rs`, `pub struct StallTracker`:
    - `new(now)`
    - `on_video(now)`
    - `tick(now) -> StallAction`, with `StallAction::{None, Restart}`
    - `stalled(&self) -> bool`
  - It encodes:
    - stalled after 12 s without video
    - `Restart` at most twice, at least 30 s apart, the first at the moment of stalling
    - the budget resets after 30 s of continuous video
  - `#[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct WebcamStatus`, with fields:
    - `state: WebcamPhase`, serialised as lowercase `"off" | "starting" | "streaming" | "stalled" | "stopped"`
    - `url: Option<String>`
    - `codec: Option<String>` (`"H.265"` or `"H.264"`)
    - `width: Option<u32>`
    - `height: Option<u32>`
    - `clients: u32`
    - `seconds_since_frame: Option<f64>`
  - The phases:
    - `starting`: acquired, no video yet
    - `streaming`: video within 12 s
    - `stalled`: the tracker says stalled
    - `stopped`: wanted but no session
    - `off`: not wanted
  - `pub struct WebcamState`, holding: wanted flag, listener port, server and monitor `JoinHandle`s, client counter `Arc<AtomicU32>`.
  - The monitor task ticks every 1 s. It feeds `relay.last_video()` into the tracker; on `Restart` it sends `CODE_STOP_LIVE_STREAM` and then `build_start_live_stream_body()` START on the current session.
  - Commands:
    - `luna_webcam_start() -> Result<WebcamStatus, String>` is idempotent. It errors with `"camera is not connected"` when there is no session. The listener stays bound until `luna_webcam_stop`, so the URL is stable across reconnects.
    - `luna_webcam_stop() -> Result<(), String>` is idempotent.
    - `luna_webcam_status() -> WebcamStatus`

- [ ] **Step 1: Write the failing tests:**
  - `stall.rs`, with a fake `Instant` base:
    - `not_stalled_before_12s`
    - `stalls_after_12s_and_restarts_once`
    - `second_restart_waits_30s`
    - `no_third_restart`
    - `budget_resets_after_30s_of_video`
    - `video_after_stall_clears_stalled`
  - `server.rs`:
    - `serves_ts_with_mp2t_header`: bind on port 0 through a test seam, `bind_on(addr)`. Request `GET /webcam.ts`; the head contains `Content-Type: video/mp2t` and the first body byte is `0x47`.
    - `other_paths_404`
    - `falls_back_when_port_taken`: hold `127.0.0.1:49283` in the test, call `bind_webcam`, and expect a different port. If 49283 is already busy on the machine, assert only that the bind succeeded.
  - Status mapping as a pure fn, `fn phase(wanted: bool, connected: bool, last_video: Option<Instant>, stalled: bool, now: Instant) -> WebcamPhase`, with one case per phase.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml --lib webcam`. Expected: FAIL.
- [ ] **Step 3: Implement** `server.rs`, `stall.rs`, `WebcamState` and the three commands. Register them in `lib.rs`.
- [ ] **Step 4: Run** `cargo test --manifest-path src-tauri/Cargo.toml --lib` and `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(webcam): serve the preview as MPEG-TS on a fixed localhost port`.

### Task 9: Transport methods and `useWebcam`

**Files:**
- Modify: `app/types/media.ts` (add `WebcamStatus`, `WebcamPhase`, matching Task 8's serde output)
- Modify: `app/utils/transport.ts`, `app/utils/lunaClient.ts`, `tests/helpers/fakeTransport.ts`, `docs/site/app/mocks/mockClient.ts`
- Create: `app/composables/useWebcam.ts`
- Test: `tests/nuxt/useWebcam.test.ts`

**Interfaces:**
- Produces:
  - `CameraTransport.webcamStart(): Promise<WebcamStatus>`, `webcamStop(): Promise<void>`, `webcamStatus(): Promise<WebcamStatus>`. They are required; the docs mock returns a fixed `streaming` status at `http://127.0.0.1:49283/webcam.ts`, 1280×720 H.265.
  - `useWebcam()` returns `{ enabled: Ref<boolean>, status: Ref<WebcamStatus | null>, error: Ref<string | null>, blockedByDownloads: ComputedRef<boolean>, turnOn(): Promise<void>, turnOff(): Promise<void> }`.
  - `useState` keys: `webcam-enabled`, `webcam-status`, `webcam-error`.
- Behaviour:
  - `turnOn` refuses while `useDownloads()` has a `downloading` or `queued` entry. It sets `error` to "Finish or cancel your downloads first." and leaves `enabled` false.
  - Otherwise it sets `enabled`, calls `webcamStart` and polls `webcamStatus` every 1000 ms while enabled.
  - When `isConnected` goes false while enabled, `status.state` becomes `"stopped"` and `enabled` stays true. When it becomes true again, `webcamStart` is called again.
  - `turnOff` clears polling and calls `webcamStop`.
  - Errors go through `errorMessage(cause, "Webcam mode could not start.")`.
  - While enabled, call `setCameraQueueHeld(true)` from Task 10; on turn-off, call `setCameraQueueHeld(false)`.

- [ ] **Step 1: Write the failing tests** (nuxt project, fake timers, `makeFakeTransport` overrides):
  - `turns on and polls status every second`
  - `refuses while a download is queued` (expect the exact error copy, and `webcamStart` not called)
  - `resumes after a reconnect`: toggle `isConnected` false then true, and expect `webcamStart` called twice and `enabled` still true.
  - `shows stopped while disconnected`
  - `turnOff stops polling and calls webcamStop`
  - `keeps the message when start rejects with a bare string`
- [ ] **Step 2: Run** `bunx vitest run -c vitest.nuxt.config.ts tests/nuxt/useWebcam.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the transport methods (`tauriInvoke("luna_webcam_start")`, etc.), the mocks and `useWebcam`.
- [ ] **Step 4: Run** `bun run test && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(webcam): webcam state and transport for the frontend`.

### Task 10: UI — camera panel, gallery hold, status indicator

**Files:**
- Modify: `app/utils/cameraQueue.ts` (+ `tests/cameraQueue.test.ts`)
- Create: `app/components/WebcamPanel.vue`
- Modify: `app/pages/camera.vue`, `app/pages/gallery.vue`, `app/pages/downloads.vue`, `app/components/SelectionBar.vue`, `app/components/CameraStatusChip.vue`
- Modify: `app/composables/useDownloads.ts` (defensive: `processNext` returns while held)

**Interfaces:**
- Consumes: `useWebcam` (Task 9).
- Produces:
  - `setCameraQueueHeld(value: boolean): void` and `isCameraQueueHeld(): boolean` in `cameraQueue.ts`.
  - Held is separate from `paused`: while held, no task of any priority starts. Releasing drains the queue.

- [ ] **Step 1: Write the failing tests:**
  - `cameraQueue.test.ts`:
    - `held queue runs nothing until released`: hold, enqueue a PREVIEW and a THUMBNAIL task, flush, expect neither run; release, and expect both run.
    - `hold and pause are independent`: pause + hold, release the hold, and expect only PREVIEW to run.
  - `useDownloads.test.ts`: `does not start a queued download while the camera queue is held`.
- [ ] **Step 2: Run** `bunx vitest run tests/cameraQueue.test.ts && bunx vitest run -c vitest.nuxt.config.ts tests/nuxt/useDownloads.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the hold and the `processNext` guard.
- [ ] **Step 4: Build the UI.**
  - `WebcamPanel.vue` sits below `CameraCaptureBar` on `camera.vue`. It contains:
    - a `USwitch` labelled "Webcam mode"
    - when enabled:
      - the URL in a read-only `UInput`, with a copy `UButton` (`i-lucide-copy`, `useClipboard`)
      - a status line: Streaming · W×H / Waiting for camera / Camera disconnected / the stall copy
      - a `ULink` "Set up OBS" to the docs page from Task 11
    - `useWebcam().error` shown under the switch
  - Text is `text-sm` or larger. The chip and toolbar get `self-start` inside `flex-col`.
  - The camera page keeps `onBeforeRouteLeave(stop)`: release only the viewfinder.
  - `gallery.vue` and `downloads.vue`: when `useWebcam().enabled`, show a `UAlert` (`color="warning"`, `variant="subtle"`) with the notice copy and an action "Turn off webcam mode" that calls `turnOff`.
  - `SelectionBar.vue`: Download disabled while enabled.
  - `CameraStatusChip.vue`: when enabled, an extra `i-lucide-webcam` icon with tooltip "Webcam mode on".
- [ ] **Step 5: Verify in the running app** (`bun run tauri dev`, or the docs-site demo via `bun run --cwd docs/site dev` for the mock):
  - Screenshot the camera page with webcam off, on and streaming, and stalled (force it in the mock by overriding the status).
  - Screenshot the gallery notice and the status chip, collapsed and expanded.
  - Zoom on the panel at device scale and check the right edge and bottom of the panel for clipping.
- [ ] **Step 6: Run** `bun run test && bun run typecheck && bun run lint`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(webcam): webcam mode toggle, stream address and gallery hold`.

### Task 11: Manual and docs

**Files:**
- Create: `docs/site/content/docs/4.webcam.md` (the docs numbering has a gap at 4)
- Modify: `README.md` (Features list), `docs/FEATURES.md` (Live view table: add "Webcam mode (OBS)"; change "Control-session H.264 stream" to "H.265/H.264"; fix the 1280×960 claim to "resolution follows the camera mode, read from the stream"; reword "releases the camera's single HTTP connection" to "releases the viewfinder's claim on the preview")
- Modify: `docs/site/content/docs/3.using-the-app.md` (one paragraph linking to the webcam page)
- Add: screenshots from Task 10 to `docs/site/public/` if the neighbouring pages use images; otherwise none.

- [ ] **Step 1: Write `4.webcam.md`** with:
  - frontmatter `title: Use as a webcam (OBS)`
  - **Install OBS**: link to obsproject.com
  - **Turn on Webcam mode**: Camera page → Webcam mode → Copy
  - **Add it to OBS**:
    - Sources → + → Media Source
    - untick Local File
    - paste the address into Input
    - untick "Restart playback when source becomes active"
  - **Start Virtual Camera**, then pick "OBS Virtual Camera" in Zoom, Meet, Teams or Discord
  - **Keep the camera awake**: on the camera, set Screen Auto Sleep and Auto Power Off to their longest or Off, and keep it on power for long calls. If the app says the camera stopped sending video, tap the camera's screen.
  - **Limits**:
    - no audio
    - the preview's resolution only (around 720p)
    - some delay
    - the picture turns portrait in Photo, Video and Pure modes
    - thumbnails and downloads pause while Webcam mode is on
- [ ] **Step 2: Check** `bun run --cwd docs/site build` succeeds (or the site's existing check command).
- [ ] **Step 3: Commit** `docs: webcam mode with OBS`.

### Task 12: Real-camera fixtures, on-device checks, release

Owner-dependent steps are marked **(owner)**.

- [ ] **Step 1 (owner):**
  - Run `node scripts/probe-liveview.mjs --seconds 20` in Video mode.
  - Run it again while switching Video → Photo → Slow-mo during the capture.
  - Hand over both `probe-out/tcp-dump.bin` files and the `report.txt` lines saying whether OSC MJPEG was offered.
- [ ] **Step 2:** Extract the video substream (`0x20`) from each dump into `src-tauri/tests/fixtures/camera-video.h265` and `camera-switch.h265`, trimmed to ≤ 1 MB each. Add both to the Task 4 and Task 6 tests (AU count > 0, keyframe present, dimensions read, ffmpeg decode clean). Fix whatever they expose.
- [ ] **Step 3 (owner), on device with OBS on macOS:**
  1. OBS plays the stream, and OBS Virtual Camera shows in a browser camera test.
  2. Remove and re-add the OBS source mid-stream; switch camera modes during a stream.
  3. A 30-minute run with screen sleep off.
  4. Let the screen sleep; the stall copy appears, and tapping the screen recovers it.
  5. With webcam mode on, temporarily release the hold (dev build with `setCameraQueueHeld(false)` from the console) and browse the gallery. If the stream doesn't break, remove the hold and the notice in a follow-up commit before release, and update `4.webcam.md`'s Limits.
- [ ] **Step 4:** Record the results in the `docs/FEATURES.md` webcam row.
- [ ] **Step 5:** Push and watch CI: `gh run watch <id> --exit-status`. Only when it is green, run `bun run release 0.4.0`, then watch the release workflow.
