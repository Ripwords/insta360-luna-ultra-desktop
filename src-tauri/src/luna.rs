//! Insta360 Luna Ultra TCP control protocol (UCD2 framing), ported from
//! luna-ai-cut's electron/insta360TcpProtocol.ts. The camera exposes:
//! - TCP control on port 6666: auth handshake, device info, delete commands.
//!   A live control session also unlocks the camera's HTTP media index.
//! - HTTP on port 80: autoindex-style media listings and Range downloads
//!   (consumed from the frontend via the http plugin).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU8, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::TcpStream;
use tokio::sync::{broadcast, oneshot, Mutex};
use tokio::task::JoinHandle;

const UCD2_MAGIC: &[u8; 4] = b"UCD2";
const UCD2_VERSION: u8 = 0x01;
const UCD2_FLAGS: u8 = 0x0c;
const UCD2_FILE: u8 = 0x04;
const UCD2_STREAM: u8 = 0x05;
/// Live media (video, secondary preview, gyro) rides its own frame type.
const UCD2_MEDIA: u8 = 0x01;

/// Every media frame opens with a 9-byte header; the Annex-B elementary
/// stream begins immediately after it.
const MEDIA_HEADER_LEN: usize = 9;
/// Substream selector, the first header byte. 0x30 is the secondary preview
/// and 0x40 is gyro; only the primary video is forwarded.
pub(crate) const MEDIA_VIDEO: u8 = 0x20;

pub(crate) const CODE_START_LIVE_STREAM: u16 = 1;
pub(crate) const CODE_STOP_LIVE_STREAM: u16 = 2;
/// SetAccessCameraFileState { AccessState state = 1 }: tells the camera what
/// the app is doing with it.
pub(crate) const CODE_SET_ACCESS_CAMERA_FILE_STATE: u16 = 118;
const CODE_TAKE_PICTURE: u16 = 3;
const CODE_START_CAPTURE: u16 = 4;
const CODE_STOP_CAPTURE: u16 = 5;
const CODE_SET_OPTIONS: u16 = 7;
const CODE_GET_OPTIONS: u16 = 8;
const CODE_SET_PHOTOGRAPHY_OPTIONS: u16 = 9;
const CODE_GET_PHOTOGRAPHY_OPTIONS: u16 = 10;
const CODE_DELETE_FILES: u16 = 12;
const CODE_GET_FILE_LIST: u16 = 13;
const CODE_GET_CURRENT_CAPTURE_STATUS: u16 = 15;

const CONTROL_PORT: u16 = 6666;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(1500);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(3);
/// While the camera's single-connection HTTP server streams a large file it can
/// be too busy to answer keepalive queries, so a failed tick within this long of
/// the last bytes it delivered is not counted against it. Bounded by bytes, not
/// by a begin/end pair, so a transfer that stalls or is never closed (webview
/// reload) cannot hide a camera that has really gone. It also covers the
/// sluggish spell right after a large file finishes.
const TRANSFER_ACTIVITY_WINDOW: Duration = Duration::from_secs(90);
const KEEPALIVE_COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
/// Slower ticks while a transfer is active give the busy camera fewer queries
/// to queue. The ~9GB hardware run that validated this change used this value.
const KEEPALIVE_COMMAND_TIMEOUT_BUSY: Duration = Duration::from_secs(25);

/// While video MEDIA frames are arriving the camera is too busy to answer the
/// keepalive queries, and the frames themselves prove the link is alive.
const VIDEO_ALIVE_WINDOW: Duration = Duration::from_secs(12);
/// Bounds a socket write so a wedged peer cannot hang the session forever.
const WRITE_TIMEOUT: Duration = Duration::from_secs(3);

fn video_recent(last_video: Option<Instant>, now: Instant) -> bool {
    last_video.is_some_and(|at| now.saturating_duration_since(at) < VIDEO_ALIVE_WINDOW)
}

pub(crate) fn same_session(a: &Arc<Session>, b: &Arc<Session>) -> bool {
    Arc::ptr_eq(a, b)
}

fn within_transfer_window(last_activity: Option<Instant>, now: Instant) -> bool {
    last_activity.is_some_and(|at| now.saturating_duration_since(at) < TRANSFER_ACTIVITY_WINDOW)
}

/// Insta360's packet checksum, appended little-endian to every UCD2 FILE
/// frame. A nonstandard CRC-32 variant (poly 0x04C11DB7): each input byte is
/// XORed into the LOW byte and followed by four MSB table rounds. Ported
/// verbatim from insta360TcpProtocol.ts; do not "fix" it to a standard CRC.
fn checksum_table() -> &'static [u32; 256] {
    use std::sync::OnceLock;
    static TABLE: OnceLock<[u32; 256]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = [0u32; 256];
        for (i, slot) in table.iter_mut().enumerate() {
            let mut value = (i as u32) << 24;
            for _ in 0..8 {
                value = if value & 0x8000_0000 != 0 {
                    (value << 1) ^ 0x04c1_1db7
                } else {
                    value << 1
                };
            }
            *slot = value;
        }
        table
    })
}

fn insta360_checksum(data: &[u8]) -> u32 {
    let table = checksum_table();
    let mut checksum: u32 = 0xffff_ffff;
    for &byte in data {
        checksum ^= u32::from(byte);
        for _ in 0..4 {
            checksum = (checksum << 8) ^ table[(checksum >> 24) as usize];
        }
    }
    checksum
}

fn wire_varint(mut value: u32) -> Vec<u8> {
    let mut out = Vec::new();
    while value > 0x7f {
        out.push(((value & 0x7f) as u8) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
    out
}

pub(crate) fn wire_field_varint(field: u32, value: u32) -> Vec<u8> {
    let mut out = wire_varint(field << 3);
    out.extend(wire_varint(value));
    out
}

/// DeleteFiles { repeated string uri = 1 }
fn build_delete_files_body(camera_paths: &[String]) -> Vec<u8> {
    let mut body = Vec::new();
    for path in camera_paths {
        let bytes = path.as_bytes();
        body.push(0x0a);
        body.extend(wire_varint(bytes.len() as u32));
        body.extend_from_slice(bytes);
    }
    body
}

fn build_ucd2(frame_type: u8, seq: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(8 + payload.len());
    frame.extend_from_slice(UCD2_MAGIC);
    frame.push(UCD2_VERSION);
    frame.push(UCD2_FLAGS);
    frame.push(frame_type);
    frame.push(seq);
    frame.extend_from_slice(payload);
    frame
}

fn build_stream_hello(seq: u8) -> Vec<u8> {
    let mut payload = vec![0u8; 4];
    payload.extend_from_slice(&[0xf6, 0xcc, 0x4f, 0x09]);
    build_ucd2(UCD2_STREAM, seq, &payload)
}

fn build_file_command(seq: u8, code: u16, request_id: u16, body: &[u8]) -> Vec<u8> {
    let mut raw = Vec::with_capacity(9 + body.len());
    raw.extend_from_slice(&code.to_le_bytes());
    raw.push(0x02);
    raw.extend_from_slice(&request_id.to_le_bytes());
    raw.extend_from_slice(&0x8000u32.to_le_bytes());
    raw.extend_from_slice(body);

    let mut payload = Vec::with_capacity(4 + raw.len());
    payload.extend_from_slice(&(raw.len() as u32).to_le_bytes());
    payload.extend_from_slice(&raw);

    let mut frame = build_ucd2(UCD2_FILE, seq, &payload);
    let trailer = insta360_checksum(&frame).to_le_bytes();
    frame.extend_from_slice(&trailer);
    frame
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RawResponse {
    /// Echoed command code; asserted in tests, carried for future status checks.
    #[allow(dead_code)]
    code: u16,
    request_id: u16,
    body: Vec<u8>,
}

/// A parsed UCD2 frame. FILE answers commands, STREAM is the keepalive
/// echo, and MEDIA carries the live preview substreams.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Frame {
    File(RawResponse),
    /// Keepalive echo. Carries no payload we use — the probe proved video
    /// rides MEDIA frames, never these.
    Stream,
    Media {
        substream: u8,
        data: Vec<u8>,
    },
}

/// Incremental UCD2 frame scanner over the receive buffer. Returns complete
/// frames and consumes processed bytes.
///
/// All three frame types share one length formula: `12 + declared + 4`. The
/// keepalive hello declares zero and is 16 bytes, so it is simply the
/// degenerate case rather than a special case.
fn drain_frames(buffer: &mut Vec<u8>) -> Vec<Frame> {
    let mut frames = Vec::new();
    loop {
        let Some(start) = buffer.windows(4).position(|w| w == UCD2_MAGIC) else {
            // A read may end mid-magic: keep the longest suffix that could
            // still become one, drop everything before it.
            let keep = (1..UCD2_MAGIC.len().min(buffer.len() + 1))
                .rev()
                .find(|&n| buffer.ends_with(&UCD2_MAGIC[..n]))
                .unwrap_or(0);
            let discard = buffer.len() - keep;
            buffer.drain(..discard);
            break;
        };
        if start > 0 {
            buffer.drain(..start);
        }
        if buffer.len() < 12 {
            break;
        }
        let frame_type = buffer[6];
        if frame_type != UCD2_FILE && frame_type != UCD2_STREAM && frame_type != UCD2_MEDIA {
            buffer.drain(..8);
            continue;
        }
        let declared = u32::from_le_bytes([buffer[8], buffer[9], buffer[10], buffer[11]]) as usize;
        // Guard against a corrupt length turning into an unbounded allocation
        if declared > 8 * 1024 * 1024 {
            buffer.drain(..8);
            continue;
        }
        let frame_len = 12 + declared + 4;
        if buffer.len() < frame_len {
            break;
        }
        let frame: Vec<u8> = buffer.drain(..frame_len).collect();

        if frame_type == UCD2_STREAM {
            frames.push(Frame::Stream);
            continue;
        }
        if frame_type == UCD2_MEDIA {
            if declared > MEDIA_HEADER_LEN {
                frames.push(Frame::Media {
                    substream: frame[12],
                    data: frame[12 + MEDIA_HEADER_LEN..12 + declared].to_vec(),
                });
            }
            continue;
        }
        if declared < 9 {
            continue;
        }
        let raw = &frame[12..12 + declared];
        frames.push(Frame::File(RawResponse {
            code: u16::from_le_bytes([raw[0], raw[1]]),
            request_id: u16::from_le_bytes([raw[3], raw[4]]),
            body: raw[9..].to_vec(),
        }));
    }
    frames
}

fn extract_ascii_strings(data: &[u8]) -> Vec<String> {
    let mut strings = Vec::new();
    let mut current = String::new();
    for &byte in data {
        if (0x20..=0x7e).contains(&byte) {
            current.push(byte as char);
        } else {
            if current.len() >= 4 {
                strings.push(std::mem::take(&mut current));
            }
            current.clear();
        }
    }
    if current.len() >= 4 {
        strings.push(current);
    }
    strings
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LunaDeviceInfo {
    pub host: String,
    pub device_name: Option<String>,
    pub serial: Option<String>,
    pub firmware: Option<String>,
    pub ssid: Option<String>,
}

/// Heuristic device-info extraction from GET_OPTIONS / capture-status
/// responses, mirroring luna-ai-cut's insta360DeviceInfo.ts.
fn parse_device_info(host: &str, bodies: &[Vec<u8>]) -> LunaDeviceInfo {
    let mut seen: Vec<String> = Vec::new();
    for body in bodies {
        for text in extract_ascii_strings(body) {
            if !seen.contains(&text) {
                seen.push(text);
            }
        }
    }
    let contains_brand = |text: &str| {
        let lower = text.to_lowercase();
        lower.contains("insta360") || lower.contains("luna") || lower.contains("ultra")
    };
    let device_name = seen.iter().find(|text| contains_brand(text)).cloned();
    let serial = seen
        .iter()
        .find(|text| {
            text.len() >= 8
                && text
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        })
        .cloned();
    let firmware = seen
        .iter()
        .find(|text| {
            let stripped = text.strip_prefix('v').unwrap_or(text);
            let parts: Vec<&str> = stripped.splitn(3, '.').collect();
            parts.len() == 3
                && parts
                    .iter()
                    .take(2)
                    .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
        })
        .cloned();
    let ssid = seen
        .iter()
        .find(|text| {
            let lower = text.to_lowercase();
            (lower.contains("luna") || lower.contains("ultra") || lower.contains(".osc"))
                && Some(*text) != device_name.as_ref()
        })
        .cloned();
    LunaDeviceInfo {
        host: host.to_string(),
        device_name,
        serial,
        firmware,
        ssid,
    }
}

pub(crate) struct Session {
    writer: Mutex<OwnedWriteHalf>,
    pending: Arc<StdMutex<HashMap<u16, oneshot::Sender<RawResponse>>>>,
    seq: AtomicU8,
    request_id: AtomicU16,
    reader: StdMutex<Option<JoinHandle<()>>>,
    keepalive: StdMutex<Option<JoinHandle<()>>>,
    info: StdMutex<LunaDeviceInfo>,
    stream_tx: broadcast::Sender<Vec<u8>>,
    /// When a download last received bytes, as reported by `luna_transfer_activity`.
    last_transfer_activity: StdMutex<Option<Instant>>,
    /// When the reader last received a video MEDIA frame.
    last_video: Arc<StdMutex<Option<Instant>>>,
    /// Set when a write timed out mid-packet: the wire holds a partial frame,
    /// so the session is unusable and must be evicted.
    poisoned: AtomicBool,
}

impl Session {
    fn next_seq(&self) -> u8 {
        self.seq.fetch_add(1, Ordering::Relaxed)
    }

    fn next_request_id(&self) -> u16 {
        self.request_id.fetch_add(1, Ordering::Relaxed)
    }

    fn device_info(&self) -> LunaDeviceInfo {
        self.info.lock().unwrap().clone()
    }

    fn note_transfer_activity(&self) {
        *self.last_transfer_activity.lock().unwrap() = Some(Instant::now());
    }

    fn is_poisoned(&self) -> bool {
        self.poisoned.load(Ordering::Relaxed)
    }

    pub(crate) fn last_video(&self) -> Option<Instant> {
        *self.last_video.lock().unwrap()
    }

    fn is_transfer_active(&self) -> bool {
        within_transfer_window(*self.last_transfer_activity.lock().unwrap(), Instant::now())
    }

    async fn write(&self, packet: &[u8]) -> Result<(), String> {
        if self.is_poisoned() {
            return Err("camera connection lost".into());
        }
        let write = async {
            let mut writer = self.writer.lock().await;
            writer.write_all(packet).await
        };
        match tokio::time::timeout(WRITE_TIMEOUT, write).await {
            Ok(result) => result.map_err(|e| format!("camera write failed: {e}")),
            Err(_) => {
                self.poisoned.store(true, Ordering::Relaxed);
                Err("camera write timed out".into())
            }
        }
    }

    async fn send_packet(
        &self,
        packet: Vec<u8>,
        request_id: u16,
        timeout: Duration,
    ) -> Result<RawResponse, String> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(request_id, tx);
        if let Err(error) = self.write(&packet).await {
            self.pending.lock().unwrap().remove(&request_id);
            return Err(error);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err("camera control session closed".into()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&request_id);
                Err(format!("camera command timed out (request {request_id})"))
            }
        }
    }

    /// Subscribe to live video payloads. Bounded: a slow consumer drops
    /// frames rather than growing memory without limit.
    pub(crate) fn subscribe_stream(&self) -> broadcast::Receiver<Vec<u8>> {
        self.stream_tx.subscribe()
    }

    pub(crate) async fn send_command(
        &self,
        code: u16,
        body: &[u8],
        timeout: Duration,
    ) -> Result<RawResponse, String> {
        let request_id = self.next_request_id();
        let packet = build_file_command(self.next_seq(), code, request_id, body);
        self.send_packet(packet, request_id, timeout).await
    }

    /// Replays a captured command byte-for-byte (fixed seq and request id),
    /// as the original app does during the info handshake.
    async fn send_exact(
        &self,
        seq: u8,
        code: u16,
        request_id: u16,
        body: &[u8],
        timeout: Duration,
    ) -> Result<RawResponse, String> {
        let packet = build_file_command(seq, code, request_id, body);
        self.send_packet(packet, request_id, timeout).await
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(reader) = self.reader.lock().unwrap().take() {
            reader.abort();
        }
        if let Some(keepalive) = self.keepalive.lock().unwrap().take() {
            keepalive.abort();
        }
    }
}

#[derive(Default)]
pub struct LunaState {
    session: Arc<Mutex<Option<Arc<Session>>>>,
}

impl LunaState {
    /// The live control session, if one is open.
    pub(crate) async fn session(&self) -> Option<Arc<Session>> {
        self.session.lock().await.as_ref().cloned()
    }
}

fn small_options_body() -> Vec<u8> {
    let mut body = wire_field_varint(1, 48);
    body.extend(wire_field_varint(1, 15));
    body.extend(wire_field_varint(1, 11));
    body
}

fn large_options_body() -> Vec<u8> {
    const HEX: &str = "0801080308020

84c0806084e084f080b0855080c080d08af01080e080f0813083708110814081e0824086e0872087508590874087308250826082a08280829083008310832084208840108
3a083b083c08430844085d08530852084608580867081008610885010886010877087a087b087c088001088101088701089601089501089301089b01089d01089e0108a001
08b30108a10108160850085108a70108a90108ad0108b40108b00108b1010878086f087908ac01";
    let cleaned: String = HEX.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    (0..cleaned.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&cleaned[i..i + 2], 16).unwrap())
        .collect()
}

/// Wraps a connected control socket in a session and starts its reader,
/// which routes command responses and forwards primary video.
fn start_session(stream: TcpStream, first_seq: u8) -> Arc<Session> {
    let (mut read_half, write_half) = stream.into_split();
    let pending: Arc<StdMutex<HashMap<u16, oneshot::Sender<RawResponse>>>> = Arc::default();

    let (stream_tx, _) = broadcast::channel::<Vec<u8>>(512);

    let last_video: Arc<StdMutex<Option<Instant>>> = Arc::default();

    let session = Arc::new(Session {
        writer: Mutex::new(write_half),
        pending: Arc::clone(&pending),
        seq: AtomicU8::new(first_seq),
        request_id: AtomicU16::new(1),
        reader: StdMutex::new(None),
        keepalive: StdMutex::new(None),
        info: StdMutex::new(LunaDeviceInfo::default()),
        stream_tx: stream_tx.clone(),
        last_transfer_activity: StdMutex::new(None),
        last_video: Arc::clone(&last_video),
        poisoned: AtomicBool::new(false),
    });

    let reader_pending = pending;
    let reader = tokio::spawn(async move {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 16 * 1024];
        loop {
            match read_half.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buffer.extend_from_slice(&chunk[..n]);
                    for frame in drain_frames(&mut buffer) {
                        match frame {
                            Frame::File(response) => {
                                if let Some(tx) =
                                    reader_pending.lock().unwrap().remove(&response.request_id)
                                {
                                    let _ = tx.send(response);
                                }
                            }
                            Frame::Media { substream, data }
                                if substream == MEDIA_VIDEO && !data.is_empty() =>
                            {
                                *last_video.lock().unwrap() = Some(Instant::now());
                                let _ = stream_tx.send(data);
                            }
                            // Secondary preview and gyro substreams are ignored
                            Frame::Media { .. } => {}
                            // STREAM frames are keepalive echoes, never video
                            Frame::Stream => {}
                        }
                    }
                }
            }
        }
        // Socket gone: anything still pending gets a closed-channel error
        reader_pending.lock().unwrap().clear();
    });
    session.reader.lock().unwrap().replace(reader);
    session
}

async fn open_session(
    app: AppHandle,
    state: Arc<Mutex<Option<Arc<Session>>>>,
    host: String,
) -> Result<LunaDeviceInfo, String> {
    let stream = tokio::time::timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((host.as_str(), CONTROL_PORT)),
    )
    .await
    .map_err(|_| format!("connecting to {host}:{CONTROL_PORT} timed out"))?
    .map_err(|e| format!("cannot reach camera at {host}:{CONTROL_PORT}: {e}"))?;

    let session = start_session(stream, 0x24);

    // STREAM hello authorizes the HTTP media index a moment later
    session
        .write(&build_stream_hello(session.next_seq()))
        .await?;

    // Device info probes; tolerate individual failures like the original app
    let info_timeout = Duration::from_secs(4);
    let mut bodies = Vec::new();
    let probes: [(u16, u16, Vec<u8>); 3] = [
        (CODE_GET_OPTIONS, 1, small_options_body()),
        (CODE_GET_CURRENT_CAPTURE_STATUS, 2, Vec::new()),
        (CODE_GET_OPTIONS, 3, large_options_body()),
    ];
    for (code, request_id, body) in probes {
        let seq = session.next_seq();
        if let Ok(response) = session
            .send_exact(seq, code, request_id, &body, info_timeout)
            .await
        {
            bodies.push(response.body);
        }
    }
    session.request_id.store(12, Ordering::Relaxed);

    let info = parse_device_info(&host, &bodies);
    *session.info.lock().unwrap() = info.clone();

    // Keepalive: hello + light status/options queries every 3s. Two straight
    // failures means the camera is gone: drop the session and tell the UI.
    // Failures inside TRANSFER_ACTIVITY_WINDOW don't count.
    let ka_state = Arc::clone(&state);
    let ka_session = Arc::downgrade(&session);
    let ka_app = app.clone();
    let keepalive = tokio::spawn(async move {
        let mut failures = 0u8;
        let mut ticker = tokio::time::interval(KEEPALIVE_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let Some(session) = ka_session.upgrade() else {
                break;
            };
            let transfer_active = session.is_transfer_active();
            let hello = build_stream_hello(session.next_seq());
            let cmd_timeout = if transfer_active {
                KEEPALIVE_COMMAND_TIMEOUT_BUSY
            } else {
                KEEPALIVE_COMMAND_TIMEOUT
            };
            let tick = async {
                session.write(&hello).await?;
                if !video_recent(session.last_video(), Instant::now()) {
                    session
                        .send_command(CODE_GET_CURRENT_CAPTURE_STATUS, &[], cmd_timeout)
                        .await?;
                    session
                        .send_command(CODE_GET_OPTIONS, &small_options_body(), cmd_timeout)
                        .await?;
                }
                Ok::<(), String>(())
            };
            match tick.await {
                Ok(()) => failures = 0,
                Err(_) if transfer_active && !session.is_poisoned() => failures = 0,
                Err(_) => {
                    failures += 1;
                    if failures >= 2 || session.is_poisoned() {
                        let mut stored = ka_state.lock().await;
                        if stored
                            .as_ref()
                            .is_some_and(|current| same_session(current, &session))
                        {
                            stored.take();
                            // Emitted under the lock so a reconnect cannot see a stale event
                            let _ = ka_app.emit("luna://disconnected", ());
                        }
                        drop(stored);
                        drop(session);
                        break;
                    }
                }
            }
        }
    });
    session.keepalive.lock().unwrap().replace(keepalive);

    state.lock().await.replace(session);
    Ok(info)
}

#[tauri::command]
pub async fn luna_connect(
    app: AppHandle,
    state: State<'_, LunaState>,
    host: String,
) -> Result<LunaDeviceInfo, String> {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return Err("camera host is empty".into());
    }
    state.session.lock().await.take();
    open_session(app, Arc::clone(&state.session), trimmed.to_string()).await
}

#[tauri::command]
pub async fn luna_disconnect(state: State<'_, LunaState>) -> Result<(), String> {
    state.session.lock().await.take();
    Ok(())
}

#[tauri::command]
pub async fn luna_status(state: State<'_, LunaState>) -> Result<Option<LunaDeviceInfo>, String> {
    Ok(state
        .session
        .lock()
        .await
        .as_ref()
        .map(|session| session.device_info()))
}

/// The frontend received download bytes from the camera. A no-op without a session.
#[tauri::command]
pub async fn luna_transfer_activity(state: State<'_, LunaState>) -> Result<(), String> {
    if let Some(session) = state.session.lock().await.as_ref() {
        session.note_transfer_activity();
    }
    Ok(())
}

#[tauri::command]
pub async fn luna_delete_files(
    state: State<'_, LunaState>,
    paths: Vec<String>,
) -> Result<(), String> {
    let session = {
        let guard = state.session.lock().await;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| "camera is not connected".to_string())?
    };
    let mut unique: Vec<String> = Vec::new();
    for path in paths {
        if !unique.contains(&path) {
            unique.push(path);
        }
    }
    if unique.is_empty() {
        return Err("nothing to delete".into());
    }
    for batch in unique.chunks(50) {
        session
            .send_command(
                CODE_DELETE_FILES,
                &build_delete_files_body(batch),
                Duration::from_secs(20),
            )
            .await?;
    }
    Ok(())
}

/// Commands the UI may send as raw protobuf. Deliberately excludes
/// DELETE_FILES, which keeps its own batching command, and anything not
/// listed here — the webview should not be able to reach arbitrary firmware
/// commands just because the transport can carry them.
fn is_allowed_command(code: u16) -> bool {
    matches!(
        code,
        CODE_TAKE_PICTURE
            | CODE_START_CAPTURE
            | CODE_STOP_CAPTURE
            | CODE_SET_OPTIONS
            | CODE_GET_OPTIONS
            | CODE_SET_PHOTOGRAPHY_OPTIONS
            | CODE_GET_PHOTOGRAPHY_OPTIONS
            | CODE_GET_CURRENT_CAPTURE_STATUS
            | CODE_GET_FILE_LIST
    )
}

/// Send a protobuf body to the camera and return the raw response body.
/// Encoding and decoding live in the frontend, which owns the schema.
#[tauri::command]
pub async fn luna_command(
    state: State<'_, LunaState>,
    code: u16,
    body: Vec<u8>,
) -> Result<Vec<u8>, String> {
    if !is_allowed_command(code) {
        return Err(format!("command {code} is not permitted"));
    }
    let session = state
        .session()
        .await
        .ok_or_else(|| "camera is not connected".to_string())?;
    let response = session
        .send_command(code, &body, Duration::from_secs(10))
        .await?;
    Ok(response.body)
}

/// A fake camera on loopback for tests of code that drives a session.
#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use tokio::net::TcpListener;

    /// What the fake does when it receives START_LIVE_STREAM.
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub(crate) enum OnStart {
        Answer,
        /// Never answers, so the command times out.
        Ignore,
        /// Closes its sending side, so the pending command fails at once.
        /// It keeps reading and recording what arrives.
        HangUp,
    }

    pub(crate) struct FakeCamera {
        codes: Arc<StdMutex<Vec<u16>>>,
        task: JoinHandle<()>,
    }

    impl FakeCamera {
        /// Command codes received, in order, without the live-view
        /// announcement that precedes every START.
        pub(crate) fn codes(&self) -> Vec<u16> {
            let mut codes = self.all_codes();
            codes.retain(|code| *code != CODE_SET_ACCESS_CAMERA_FILE_STATE);
            codes
        }

        /// Every command code received, in order.
        pub(crate) fn all_codes(&self) -> Vec<u16> {
            self.codes.lock().unwrap().clone()
        }

        /// Waits until `count` commands other than the announcement have arrived.
        pub(crate) async fn wait_for(&self, count: usize) -> Vec<u16> {
            for _ in 0..500 {
                let codes = self.codes();
                if codes.len() >= count {
                    return codes;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("camera received only {:?}", self.codes());
        }
    }

    impl Drop for FakeCamera {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    /// A session connected to a fake camera that echoes each command back as
    /// its response, except START as `on_start` says.
    pub(crate) async fn connect(on_start: OnStart) -> (Arc<Session>, FakeCamera) {
        connect_streaming(on_start, Vec::new()).await
    }

    /// A video payload as the camera frames it: MEDIA, video substream.
    pub(crate) fn media_frame(annex_b: &[u8]) -> Vec<u8> {
        let mut payload = vec![MEDIA_VIDEO, 0, 0, 0, 0, 0, 0, 0, 0];
        payload.extend_from_slice(annex_b);
        let mut frame_payload = (payload.len() as u32).to_le_bytes().to_vec();
        frame_payload.extend_from_slice(&payload);
        frame_payload.extend_from_slice(&[0u8; 4]);
        build_ucd2(UCD2_MEDIA, 0, &frame_payload)
    }

    /// Like [`connect`], but on each START the camera first sends `video`, as
    /// a real camera starts streaming, and answers a moment later.
    pub(crate) async fn connect_streaming(
        on_start: OnStart,
        video: Vec<Vec<u8>>,
    ) -> (Arc<Session>, FakeCamera) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let codes: Arc<StdMutex<Vec<u16>>> = Arc::default();
        let recorded = Arc::clone(&codes);
        let task = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let (mut read, mut write) = socket.into_split();
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 4096];
            let mut open = true;
            while let Ok(n) = read.read(&mut chunk).await {
                if n == 0 {
                    break;
                }
                buffer.extend_from_slice(&chunk[..n]);
                for frame in drain_frames(&mut buffer) {
                    let Frame::File(command) = frame else {
                        continue;
                    };
                    recorded.lock().unwrap().push(command.code);
                    let answer =
                        command.code != CODE_START_LIVE_STREAM || on_start == OnStart::Answer;
                    if command.code == CODE_START_LIVE_STREAM && on_start == OnStart::HangUp && open
                    {
                        let _ = write.shutdown().await;
                        open = false;
                    }
                    if command.code == CODE_START_LIVE_STREAM && open && !video.is_empty() {
                        for chunk in &video {
                            let _ = write.write_all(&media_frame(chunk)).await;
                        }
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    if answer && open {
                        let reply = build_file_command(0, command.code, command.request_id, &[]);
                        let _ = write.write_all(&reply).await;
                    }
                }
            }
        });
        let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        (start_session(stream, 0), FakeCamera { codes, task })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn video_recent_requires_video_inside_window() {
        let now = Instant::now();
        assert!(!video_recent(None, now));
        assert!(video_recent(Some(now - Duration::from_secs(6)), now));
        assert!(!video_recent(Some(now - VIDEO_ALIVE_WINDOW), now));
    }

    fn test_session(write_half: OwnedWriteHalf) -> Session {
        Session {
            writer: Mutex::new(write_half),
            pending: Arc::default(),
            seq: AtomicU8::new(0),
            request_id: AtomicU16::new(1),
            reader: StdMutex::new(None),
            keepalive: StdMutex::new(None),
            info: StdMutex::new(LunaDeviceInfo::default()),
            stream_tx: broadcast::channel::<Vec<u8>>(4).0,
            last_transfer_activity: StdMutex::new(None),
            last_video: Arc::default(),
            poisoned: AtomicBool::new(false),
        }
    }

    #[tokio::test]
    async fn write_times_out_on_a_wedged_socket() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let (_read_half, write_half) = stream.into_split();
        let session = test_session(write_half);
        let payload = vec![0u8; 64 * 1024 * 1024];
        let result = tokio::time::timeout(
            WRITE_TIMEOUT + Duration::from_secs(1),
            session.write(&payload),
        )
        .await
        .expect("write must return within the write timeout");
        assert!(result.unwrap_err().contains("timed out"));

        let started = Instant::now();
        let second = session.write(b"x").await;
        assert!(second.is_err());
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn transfer_window_requires_recent_activity() {
        let now = Instant::now();
        assert!(
            !within_transfer_window(None, now),
            "no transfer has ever delivered bytes"
        );
        assert!(within_transfer_window(Some(now), now));
        assert!(within_transfer_window(
            Some(now - TRANSFER_ACTIVITY_WINDOW / 2),
            now
        ));
        assert!(
            !within_transfer_window(Some(now - TRANSFER_ACTIVITY_WINDOW), now),
            "a transfer that stopped delivering bytes must not suppress the keepalive forever"
        );
    }

    /// The mock server's second auth payload is a real captured frame:
    /// GET_OPTIONS small with seq 0x10, request 1, including its CRC trailer.
    #[test]
    fn file_command_matches_captured_auth_frame() {
        let expected = hex("55434432010c04100f0000000800020100008000000830080f080b7c008e7c");
        let built = build_file_command(0x10, CODE_GET_OPTIONS, 1, &small_options_body());
        assert_eq!(built, expected);
    }

    #[test]
    fn checksum_matches_captured_trailer() {
        let frame = hex("55434432010c04100f0000000800020100008000000830080f080b");
        assert_eq!(
            insta360_checksum(&frame),
            u32::from_le_bytes([0x7c, 0x00, 0x8e, 0x7c])
        );
    }

    #[test]
    fn stream_hello_is_sixteen_bytes() {
        let hello = build_stream_hello(0x24);
        assert_eq!(hello.len(), 16);
        assert_eq!(&hello[..4], UCD2_MAGIC);
        assert_eq!(hello[6], UCD2_STREAM);
    }

    #[test]
    fn delete_body_encodes_repeated_strings() {
        let body = build_delete_files_body(&["/DCIM/a.jpg".to_string()]);
        assert_eq!(body[0], 0x0a);
        assert_eq!(body[1] as usize, "/DCIM/a.jpg".len());
        assert_eq!(&body[2..], "/DCIM/a.jpg".as_bytes());
    }

    /// A STREAM frame carrying real video must be returned with its payload,
    /// STREAM frames are keepalive echoes only. Both a padded one and the
    /// 16-byte hello must be recognised and fully consumed, so that a MEDIA
    /// frame arriving behind them still parses.
    #[test]
    fn drain_frames_consumes_stream_frames_without_payload() {
        let mut padded = Vec::new();
        padded.extend_from_slice(&40u32.to_le_bytes());
        padded.extend_from_slice(&[0xAAu8; 40]);
        padded.extend_from_slice(&[0u8; 4]); // trailer
        let mut buffer = build_ucd2(UCD2_STREAM, 1, &padded);
        buffer.extend_from_slice(&build_stream_hello(2));

        let frames = drain_frames(&mut buffer);
        assert_eq!(frames.len(), 2);
        assert!(frames.iter().all(|f| matches!(f, Frame::Stream)));
        assert!(buffer.is_empty(), "both frames should be consumed");
    }

    /// The allowlist is the safety boundary between the webview and the
    /// camera. Destructive codes must not be reachable through it.
    #[test]
    fn command_allowlist_covers_settings_but_not_deletion() {
        for code in [
            CODE_TAKE_PICTURE,
            CODE_START_CAPTURE,
            CODE_STOP_CAPTURE,
            CODE_SET_OPTIONS,
            CODE_GET_OPTIONS,
            CODE_SET_PHOTOGRAPHY_OPTIONS,
            CODE_GET_PHOTOGRAPHY_OPTIONS,
            CODE_GET_CURRENT_CAPTURE_STATUS,
        ] {
            assert!(is_allowed_command(code), "code {code} should be allowed");
        }
        assert!(
            !is_allowed_command(CODE_DELETE_FILES),
            "deletion has its own command"
        );
        assert!(!is_allowed_command(9999), "unknown codes must be refused");
    }

    /// Video rides UCD2 type 0x01, not STREAM. Each media frame begins with a
    /// 9-byte header whose first byte selects the substream; the Annex-B
    /// elementary stream follows. Header bytes are taken from a real capture.
    #[test]
    fn drain_frames_extracts_video_from_media_frames() {
        let annex_b = [0x00, 0x00, 0x00, 0x01, 0x40, 0x01, 0x0c, 0x01];
        let build = |substream: u8| {
            let mut payload = vec![substream, 0x25, 0xde, 0xa9, 0, 0, 0, 0, 0];
            payload.extend_from_slice(&annex_b);
            let mut frame_payload = Vec::new();
            frame_payload.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            frame_payload.extend_from_slice(&payload);
            frame_payload.extend_from_slice(&[0u8; 4]); // trailer
            build_ucd2(UCD2_MEDIA, 7, &frame_payload)
        };

        let mut buffer = build(MEDIA_VIDEO);
        buffer.extend_from_slice(&build(0x40)); // gyro substream

        let frames = drain_frames(&mut buffer);
        assert_eq!(frames.len(), 2);
        match &frames[0] {
            Frame::Media { substream, data } => {
                assert_eq!(*substream, MEDIA_VIDEO);
                assert_eq!(data, &annex_b, "the 9-byte header must be stripped");
            }
            other => panic!("expected a media frame, got {other:?}"),
        }
        match &frames[1] {
            Frame::Media { substream, .. } => assert_eq!(*substream, 0x40),
            other => panic!("expected the gyro frame, got {other:?}"),
        }
        assert!(buffer.is_empty());
    }

    /// A socket read can end inside the 4-byte magic. The partial prefix must
    /// survive so the next read completes it.
    #[test]
    fn drain_frames_keeps_partial_magic() {
        let mut buffer = b"garbageUC".to_vec();
        let frames = drain_frames(&mut buffer);
        assert!(frames.is_empty());
        assert_eq!(buffer, b"UC");
    }

    /// Frames must come out identical however the stream is split across reads.
    #[test]
    fn drain_frames_is_split_invariant() {
        let mut stream = build_file_command(1, 12, 7, b"ok");
        stream.extend_from_slice(&build_stream_hello(2));
        let mut media = vec![MEDIA_VIDEO, 0x25, 0xde, 0xa9, 0, 0, 0, 0, 0];
        media.extend((0..100u8).collect::<Vec<_>>());
        let mut payload = (media.len() as u32).to_le_bytes().to_vec();
        payload.extend_from_slice(&media);
        payload.extend_from_slice(&[0u8; 4]);
        stream.extend_from_slice(&build_ucd2(UCD2_MEDIA, 3, &payload));

        let mut whole = stream.clone();
        let expected = drain_frames(&mut whole);
        assert_eq!(expected.len(), 3);
        match &expected[0] {
            Frame::File(response) => assert_eq!(response.request_id, 7),
            other => panic!("expected a file response, got {other:?}"),
        }
        assert_eq!(expected[1], Frame::Stream);
        match &expected[2] {
            Frame::Media { substream, data } => {
                assert_eq!(*substream, 0x20);
                assert_eq!(data.len(), 100);
            }
            other => panic!("expected a media frame, got {other:?}"),
        }

        for k in 0..stream.len() {
            let mut buffer = Vec::new();
            let mut got = Vec::new();
            buffer.extend_from_slice(&stream[..k]);
            got.extend(drain_frames(&mut buffer));
            buffer.extend_from_slice(&stream[k..]);
            got.extend(drain_frames(&mut buffer));
            assert_eq!(got, expected, "split at {k}");
        }

        // One byte per read: partial magic is retained repeatedly ("U", "UC", "UCD").
        let mut buffer = Vec::new();
        let mut got = Vec::new();
        for byte in &stream {
            buffer.push(*byte);
            got.extend(drain_frames(&mut buffer));
        }
        assert_eq!(got, expected, "byte-at-a-time");
        assert!(buffer.is_empty());
    }

    /// The existing FILE parsing must be untouched by the refactor.
    #[test]
    fn drain_frames_still_parses_file_responses() {
        // Mirror of the mock server's buildRawResponse + buildUcd2
        let mut raw = Vec::new();
        raw.extend_from_slice(&12u16.to_le_bytes());
        raw.push(0x03);
        raw.extend_from_slice(&7u16.to_le_bytes());
        raw.extend_from_slice(&0x8000u32.to_le_bytes());
        raw.extend_from_slice(b"ok");
        let mut payload = Vec::new();
        payload.extend_from_slice(&(raw.len() as u32).to_le_bytes());
        payload.extend_from_slice(&raw);
        payload.extend_from_slice(&[0u8; 4]);
        let mut buffer = build_ucd2(UCD2_FILE, 9, &payload);

        let frames = drain_frames(&mut buffer);
        assert_eq!(frames.len(), 1);
        match &frames[0] {
            Frame::File(response) => {
                assert_eq!(response.code, 12);
                assert_eq!(response.request_id, 7);
                assert_eq!(response.body, b"ok");
            }
            other => panic!("expected a file response, got {other:?}"),
        }
    }

    /// End-to-end against the vendored luna_mock_server: our stream hello
    /// must authorize the HTTP index, and our delete frames must be parsed
    /// by the emulator and reflected in the listing.
    #[tokio::test]
    async fn handshake_and_delete_against_mock_server() {
        use std::process::{Child, Command, Stdio};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        if Command::new("node")
            .arg("--version")
            .stdout(Stdio::null())
            .status()
            .is_err()
        {
            eprintln!("skipping: node not available");
            return;
        }

        struct KillOnDrop(Child);
        impl Drop for KillOnDrop {
            fn drop(&mut self) {
                let _ = self.0.kill();
            }
        }

        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let server = manifest_dir.join("../luna_mock_server/server.mjs");
        assert!(
            server.exists(),
            "vendored mock server missing at {server:?}"
        );

        let media_root = std::env::temp_dir().join(format!("luna-it-{}", std::process::id()));
        let camera_dir = media_root.join("Camera01");
        std::fs::create_dir_all(&camera_dir).unwrap();
        let target = "IMG_20260718_142012_00_002.jpg";
        std::fs::write(camera_dir.join(target), b"fakejpeg").unwrap();
        std::fs::write(
            camera_dir.join("IMG_20260717_091205_00_003.jpg"),
            b"fakejpeg2",
        )
        .unwrap();

        let http_port = 18142u16;
        let tcp_port = 16142u16;
        let child = Command::new("node")
            .arg(&server)
            .args(["--root", media_root.to_str().unwrap()])
            .args(["--host", "127.0.0.1"])
            .args(["--http-port", &http_port.to_string()])
            .args(["--tcp-port", &tcp_port.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let _guard = KillOnDrop(child);

        // Wait for the TCP control port to accept
        let mut control = None;
        for _ in 0..50 {
            if let Ok(stream) = TcpStream::connect(("127.0.0.1", tcp_port)).await {
                control = Some(stream);
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let mut control = control.expect("mock TCP port never came up");

        // Stream hello authorizes HTTP; a FILE command must get a response
        control.write_all(&build_stream_hello(0x24)).await.unwrap();
        control
            .write_all(&build_file_command(
                0x25,
                CODE_GET_OPTIONS,
                1,
                &small_options_body(),
            ))
            .await
            .unwrap();
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        let response = loop {
            let n = tokio::time::timeout(Duration::from_secs(3), control.read(&mut chunk))
                .await
                .expect("timed out waiting for control response")
                .unwrap();
            assert!(n > 0, "mock closed the control socket");
            buffer.extend_from_slice(&chunk[..n]);
            let mut frames = drain_frames(&mut buffer);
            if let Some(Frame::File(response)) = frames.pop() {
                break response;
            }
        };
        assert_eq!(response.code, CODE_GET_OPTIONS);
        assert_eq!(response.request_id, 1);

        // The HTTP auth gate opens ~3s after the handshake
        async fn http_get(port: u16, path: &str) -> String {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            let request =
                format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut out = Vec::new();
            let _ =
                tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut out)).await;
            String::from_utf8_lossy(&out).to_string()
        }

        let mut index = String::new();
        for _ in 0..8 {
            tokio::time::sleep(Duration::from_millis(700)).await;
            index = http_get(http_port, "/storage_internal/DCIM/Camera01/").await;
            if index.starts_with("HTTP/1.1 200") {
                break;
            }
        }
        assert!(
            index.starts_with("HTTP/1.1 200"),
            "index not authorized: {index}"
        );
        assert!(index.contains(target), "listing missing {target}: {index}");

        // Delete over TCP, then the file must vanish from the listing
        let delete_path = format!("/storage_internal/DCIM/Camera01/{target}");
        control
            .write_all(&build_file_command(
                0x26,
                CODE_DELETE_FILES,
                12,
                &build_delete_files_body(&[delete_path]),
            ))
            .await
            .unwrap();
        let deleted = loop {
            let n = tokio::time::timeout(Duration::from_secs(3), control.read(&mut chunk))
                .await
                .expect("timed out waiting for delete response")
                .unwrap();
            assert!(n > 0);
            buffer.extend_from_slice(&chunk[..n]);
            let mut frames = drain_frames(&mut buffer);
            if let Some(Frame::File(response)) = frames.pop() {
                break response;
            }
        };
        assert_eq!(deleted.code, CODE_DELETE_FILES);

        let after = http_get(http_port, "/storage_internal/DCIM/Camera01/").await;
        assert!(
            after.starts_with("HTTP/1.1 200"),
            "index lost after delete: {after}"
        );
        assert!(!after.contains(target), "deleted file still listed");
        assert!(
            after.contains("IMG_20260717_091205_00_003.jpg"),
            "unrelated file disappeared"
        );

        let _ = std::fs::remove_dir_all(&media_root);
    }

    #[test]
    fn device_info_heuristics() {
        let bodies = vec![b"\x00\x00Insta360 Luna Ultra\x00LU1XA4207731\x00v1.2.4_build1\x00Luna Ultra 1XLU42.OSC\x00".to_vec()];
        let info = parse_device_info("192.168.42.1", &bodies);
        assert_eq!(info.device_name.as_deref(), Some("Insta360 Luna Ultra"));
        assert_eq!(info.serial.as_deref(), Some("LU1XA4207731"));
        assert_eq!(info.firmware.as_deref(), Some("v1.2.4_build1"));
        assert_eq!(info.ssid.as_deref(), Some("Luna Ultra 1XLU42.OSC"));
    }
}
