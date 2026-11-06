//! Live preview ownership and the in-app viewfinder transport.
//!
//! The camera has one preview stream, shared by every consumer (the in-app
//! viewfinder and the webcam server). `LiveViewState` sends START when the
//! first consumer arrives and STOP when the last leaves, and a pump task feeds
//! the session's video payloads into a `Relay` that outlives camera sessions.
//!
//! The viewfinder re-serves the relay's Annex B stream on an ephemeral
//! localhost port. The frontend consumes that with `fetch` and decodes via
//! WebCodecs, which keeps video-rate traffic off the Tauri IPC bridge and
//! avoids the `blob:` URL decoding limitation in WKWebView.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::Mutex;
use tokio::task::{JoinHandle, JoinSet};

use crate::local_http::{
    read_request, status_response, Request, BAD_REQUEST, MISDIRECTED, REQUEST_TIMEOUT,
};
use crate::luna::{
    wire_field_varint, LunaState, Session, CODE_START_LIVE_STREAM, CODE_STOP_LIVE_STREAM,
};
use crate::webcam::relay::Relay;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
/// A client that accepts no bytes for this long is closed.
const CLIENT_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// Bounds the STOP sent after a failed START; its answer doesn't matter.
const BEST_EFFORT_TIMEOUT: Duration = Duration::from_secs(1);
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);

/// StartLiveStream, per `insta360.messages.StartLiveStream`:
///   2 enableVideo, 6 videoBitrate, 7 resolution, 8 enableGyro,
///   9 videoBitrate1, 10 resolution1
/// Resolution 9 is RES_1440_720P30 and 18 is RES_480_240P30, matching the
/// known-good capture. Values are deliberately identical to that capture so
/// that a failure here means the camera disagrees, not that we guessed.
fn build_start_live_stream_body() -> Vec<u8> {
    let mut body = wire_field_varint(2, 1);
    body.extend(wire_field_varint(6, 40));
    body.extend(wire_field_varint(7, 9));
    body.extend(wire_field_varint(8, 1));
    body.extend(wire_field_varint(9, 40));
    body.extend(wire_field_varint(10, 18));
    body
}

fn response_head() -> Vec<u8> {
    concat!(
        "HTTP/1.1 200 OK\r\n",
        "Content-Type: application/octet-stream\r\n",
        "Cache-Control: no-store\r\n",
        "Access-Control-Allow-Origin: *\r\n",
        "Connection: close\r\n\r\n"
    )
    .as_bytes()
    .to_vec()
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Consumer {
    Viewfinder,
    Webcam,
}

#[derive(Clone, Copy, Debug)]
enum Change {
    Acquire(Consumer),
    Release(Consumer),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Command {
    Start,
    Stop,
}

/// The consumer set after `change`, and the camera command it calls for:
/// START on the first acquire, STOP when the last consumer leaves.
fn transition(
    consumers: &HashSet<Consumer>,
    change: Change,
) -> (HashSet<Consumer>, Option<Command>) {
    let mut after = consumers.clone();
    let command = match change {
        Change::Acquire(consumer) => {
            after.insert(consumer);
            consumers.is_empty().then_some(Command::Start)
        }
        Change::Release(consumer) => {
            let removed = after.remove(&consumer);
            (removed && after.is_empty()).then_some(Command::Stop)
        }
    };
    (after, command)
}

/// Counters so a failed run explains itself instead of showing a blank canvas.
/// Fed by the pump, so they count whether or not a client is attached.
#[derive(Default)]
struct Stats {
    bytes: AtomicU64,
    frames: AtomicU64,
    first_bytes: StdMutex<Vec<u8>>,
    started: StdMutex<Option<Instant>>,
}

impl Stats {
    fn record(&self, payload: &[u8]) {
        self.bytes
            .fetch_add(payload.len() as u64, Ordering::Relaxed);
        self.frames.fetch_add(1, Ordering::Relaxed);
        let mut first = self.first_bytes.lock().unwrap_or_else(|e| e.into_inner());
        if first.is_empty() {
            *first = payload.iter().copied().take(64).collect();
        }
    }
}

struct Preview {
    consumers: HashSet<Consumer>,
    /// The session START was sent on, while its pump runs. Weak, so a session
    /// the keepalive evicts is dropped: its stream closes, which ends the
    /// pump, and no STOP is sent to a dead camera.
    session: Option<Weak<Session>>,
    pump: Option<JoinHandle<()>>,
    viewfinder: Option<(u16, JoinHandle<()>)>,
}

impl Preview {
    fn is_current(&self, session: &Arc<Session>) -> bool {
        self.session
            .as_ref()
            .is_some_and(|current| Weak::ptr_eq(current, &Arc::downgrade(session)))
    }
}

/// The relay and the pump's counters live outside the lock, which is held
/// across camera commands for seconds at a time.
pub struct LiveViewState {
    /// Created once; outlives camera sessions so clients survive a reconnect.
    relay: Arc<Relay>,
    stats: StdMutex<Option<Arc<Stats>>>,
    inner: Mutex<Preview>,
}

impl Default for LiveViewState {
    fn default() -> Self {
        LiveViewState {
            relay: Relay::new(),
            stats: StdMutex::new(None),
            inner: Mutex::new(Preview {
                consumers: HashSet::new(),
                session: None,
                pump: None,
                viewfinder: None,
            }),
        }
    }
}

async fn send_start(session: &Session) -> Result<(), String> {
    session
        .send_command(
            CODE_START_LIVE_STREAM,
            &build_start_live_stream_body(),
            COMMAND_TIMEOUT,
        )
        .await
        .map(|_| ())
        .map_err(|e| format!("camera rejected START_LIVE_STREAM: {e}"))
}

/// After a START that failed or timed out: the camera may have acted on it,
/// and nothing else would stop it.
async fn stop_after_failed_start(session: &Session) {
    let _ = session
        .send_command(CODE_STOP_LIVE_STREAM, &[], BEST_EFFORT_TIMEOUT)
        .await;
}

impl LiveViewState {
    /// Registers `consumer` and makes sure the camera is streaming on `session`.
    pub(crate) async fn acquire(
        &self,
        consumer: Consumer,
        session: Arc<Session>,
    ) -> Result<(), String> {
        let mut preview = self.inner.lock().await;
        self.acquire_locked(&mut preview, consumer, &session).await
    }

    /// Unregisters `consumer`; the last one out stops the camera stream.
    pub(crate) async fn release(&self, consumer: Consumer) {
        let mut preview = self.inner.lock().await;
        self.release_locked(&mut preview, consumer).await;
    }

    pub(crate) fn relay(&self) -> Arc<Relay> {
        Arc::clone(&self.relay)
    }

    /// Restarts the camera's preview for the current consumers: on a new
    /// session, moves the pump there and sends START; on the current one,
    /// cycles STOP and START. With no consumers it does nothing.
    pub(crate) async fn restart(&self, session: Arc<Session>) -> Result<(), String> {
        let mut preview = self.inner.lock().await;
        if preview.consumers.is_empty() {
            return Ok(());
        }
        if !preview.is_current(&session) {
            self.start_pump(&mut preview, &session);
            if let Err(error) = send_start(&session).await {
                stop_after_failed_start(&session).await;
                self.stop_pump(&mut preview);
                return Err(error);
            }
            return Ok(());
        }
        let _ = session
            .send_command(CODE_STOP_LIVE_STREAM, &[], COMMAND_TIMEOUT)
            .await;
        // The camera's new stream shares no references with the old one. Cut
        // before START: the camera may send its first keyframe before the ack.
        self.relay.discontinuity();
        let started = send_start(&session).await;
        if started.is_err() {
            stop_after_failed_start(&session).await;
        }
        started
    }

    fn stop_pump(&self, preview: &mut Preview) {
        if let Some(pump) = preview.pump.take() {
            pump.abort();
        }
        preview.session = None;
        *self.stats.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    fn start_pump(&self, preview: &mut Preview, session: &Arc<Session>) {
        self.stop_pump(preview);
        self.relay.discontinuity();
        let stats = Arc::new(Stats::default());
        *stats.started.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
        preview.pump = Some(tokio::spawn(pump(
            session.subscribe_stream(),
            Arc::clone(&self.relay),
            Arc::clone(&stats),
        )));
        preview.session = Some(Arc::downgrade(session));
        *self.stats.lock().unwrap_or_else(|e| e.into_inner()) = Some(stats);
    }

    /// Cancel-safe: the claim and the session are recorded before START goes
    /// out, so if this future is dropped mid-START, the consumer's release
    /// still stops the camera. On an error both are rolled back.
    async fn acquire_locked(
        &self,
        preview: &mut Preview,
        consumer: Consumer,
        session: &Arc<Session>,
    ) -> Result<(), String> {
        let before = preview.consumers.clone();
        let (after, command) = transition(&before, Change::Acquire(consumer));
        let switched = !preview.is_current(session);
        preview.consumers = after;
        if switched {
            // Existing consumers carry over: the relay keeps their sockets
            // open and resyncs on the new session's next keyframe.
            self.start_pump(preview, session);
        }
        if switched || command == Some(Command::Start) {
            if let Err(error) = send_start(session).await {
                stop_after_failed_start(session).await;
                // Forget the session so the next acquire retries START.
                self.stop_pump(preview);
                preview.consumers = before;
                return Err(error);
            }
        }
        Ok(())
    }

    async fn release_locked(&self, preview: &mut Preview, consumer: Consumer) {
        let (after, command) = transition(&preview.consumers, Change::Release(consumer));
        preview.consumers = after;
        if command == Some(Command::Stop) {
            let session = preview.session.as_ref().and_then(Weak::upgrade);
            self.stop_pump(preview);
            if let Some(session) = session {
                let _ = session
                    .send_command(CODE_STOP_LIVE_STREAM, &[], COMMAND_TIMEOUT)
                    .await;
            }
        }
    }
}

/// Feeds one session's video payloads into the relay until the session ends.
async fn pump(
    mut receiver: tokio::sync::broadcast::Receiver<Vec<u8>>,
    relay: Arc<Relay>,
    stats: Arc<Stats>,
) {
    loop {
        match receiver.recv().await {
            Ok(payload) => {
                stats.record(&payload);
                relay.push_chunk(&payload, Instant::now());
            }
            // Chunks were dropped: what follows may reference pictures that
            // never arrived, so the relay waits for the next keyframe.
            Err(RecvError::Lagged(_)) => relay.discontinuity(),
            Err(RecvError::Closed) => break,
        }
    }
}

/// Serves the relay's Annex B stream to every client that connects. Aborting
/// this task drops the client set, which closes every client socket.
async fn serve_annexb(listener: TcpListener, relay: Arc<Relay>) {
    let mut clients = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((socket, _)) => {
                    clients.spawn(serve_client(socket, Arc::clone(&relay), CLIENT_WRITE_TIMEOUT));
                }
                Err(error) => {
                    // Usually transient (out of file descriptors, a reset
                    // before accept); back off rather than spin.
                    log::warn!("viewfinder accept failed: {error}");
                    tokio::time::sleep(ACCEPT_BACKOFF).await;
                }
            },
            Some(_) = clients.join_next() => {}
        }
    }
}

/// Writes all of `bytes`, or gives up after `limit`.
pub(crate) async fn write_within(socket: &mut TcpStream, bytes: &[u8], limit: Duration) -> bool {
    matches!(
        tokio::time::timeout(limit, socket.write_all(bytes)).await,
        Ok(Ok(()))
    )
}

/// One client: the head, then the bootstrap (params, then the pictures since
/// the last keyframe), then live pictures. A client that falls behind, or
/// accepts nothing for `write_timeout`, is closed rather than continued
/// mid-GOP; the page reconnects for a clean start.
async fn serve_client(mut socket: TcpStream, relay: Arc<Relay>, write_timeout: Duration) {
    // Any path: we serve one thing. The Host check still applies.
    let refusal = match read_request(&mut socket, REQUEST_TIMEOUT).await {
        Request::Get(_) => None,
        Request::WrongHost => Some(MISDIRECTED),
        Request::Invalid => Some(BAD_REQUEST),
    };
    if let Some(status) = refusal {
        let _ = write_within(&mut socket, &status_response(status), write_timeout).await;
        return;
    }
    let subscription = relay.subscribe();
    if !write_within(&mut socket, &response_head(), write_timeout).await {
        return;
    }
    let mut started = !subscription.bootstrap.is_empty();
    for au in &subscription.bootstrap {
        if !write_within(&mut socket, &au.data, write_timeout).await {
            return;
        }
    }
    let mut live = subscription.live;
    loop {
        let au = match live.recv().await {
            Ok(au) => au,
            Err(RecvError::Lagged(_) | RecvError::Closed) => return,
        };
        if !started {
            // Nothing cached at join time: wait for a keyframe to start on,
            // led by the params it was published with.
            let (true, Some(params)) = (au.keyframe, &au.params) else {
                continue;
            };
            if !write_within(&mut socket, &params.annexb(), write_timeout).await {
                return;
            }
            started = true;
        }
        if !write_within(&mut socket, &au.data, write_timeout).await {
            return;
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveViewInfo {
    pub url: String,
    pub port: u16,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LiveViewStats {
    pub bytes: u64,
    pub frames: u64,
    pub first_bytes_hex: String,
    pub seconds: f64,
}

fn info(port: u16) -> LiveViewInfo {
    LiveViewInfo {
        url: format!("http://127.0.0.1:{port}/stream"),
        port,
    }
}

#[tauri::command]
pub async fn luna_liveview_start(
    luna: State<'_, LunaState>,
    live: State<'_, LiveViewState>,
) -> Result<LiveViewInfo, String> {
    let session = luna
        .session()
        .await
        .ok_or_else(|| "camera is not connected".to_string())?;

    let mut preview = live.inner.lock().await;
    live.acquire_locked(&mut preview, Consumer::Viewfinder, &session)
        .await?;
    if let Some((port, _)) = preview.viewfinder {
        return Ok(info(port));
    }

    let bound = async {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| format!("cannot open the local stream port: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("cannot read the local stream port: {e}"))?
            .port();
        Ok::<_, String>((listener, port))
    }
    .await;
    let (listener, port) = match bound {
        Ok(bound) => bound,
        Err(error) => {
            live.release_locked(&mut preview, Consumer::Viewfinder)
                .await;
            return Err(error);
        }
    };
    let server = tokio::spawn(serve_annexb(listener, live.relay()));
    preview.viewfinder = Some((port, server));
    Ok(info(port))
}

#[tauri::command]
pub async fn luna_liveview_stop(live: State<'_, LiveViewState>) -> Result<(), String> {
    let mut preview = live.inner.lock().await;
    // Close the sockets first so they end even if the camera is gone.
    if let Some((_, server)) = preview.viewfinder.take() {
        server.abort();
    }
    live.release_locked(&mut preview, Consumer::Viewfinder)
        .await;
    Ok(())
}

#[tauri::command]
pub async fn luna_liveview_stats(live: State<'_, LiveViewState>) -> Result<LiveViewStats, String> {
    let Some(stats) = live.stats.lock().unwrap_or_else(|e| e.into_inner()).clone() else {
        return Ok(LiveViewStats::default());
    };
    let first = stats
        .first_bytes
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let seconds = stats
        .started
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .map(|at| at.elapsed().as_secs_f64())
        .unwrap_or_default();
    Ok(LiveViewStats {
        bytes: stats.bytes.load(Ordering::Relaxed),
        frames: stats.frames.load(Ordering::Relaxed),
        first_bytes_hex: first.iter().map(|b| format!("{b:02x}")).collect(),
        seconds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The body must match the capture from published reverse-engineering
    /// work byte for byte: enableVideo, videoBitrate 40, resolution 9
    /// (RES_1440_720P30), enableGyro, videoBitrate1 40, resolution1 18.
    #[test]
    fn start_live_stream_body_matches_known_capture() {
        let expected: Vec<u8> = vec![
            0x10, 0x01, 0x30, 0x28, 0x38, 0x09, 0x40, 0x01, 0x48, 0x28, 0x50, 0x12,
        ];
        assert_eq!(build_start_live_stream_body(), expected);
    }

    #[test]
    fn http_response_head_declares_a_streaming_body() {
        let head = String::from_utf8(response_head()).unwrap();
        assert!(head.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(head.contains("Content-Type: application/octet-stream"));
        assert!(head.contains("Access-Control-Allow-Origin: *"));
        assert!(head.ends_with("\r\n\r\n"));
    }

    use crate::webcam::nal::{AccessUnit, ParamSets};
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpStream;

    const HEVC_IDR: &[u8] = include_bytes!("../tests/fixtures/hevc-idr.h265");
    const READ_LIMIT: Duration = Duration::from_secs(5);

    fn request(port: u16, host: &str) -> String {
        format!("GET /stream HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n")
    }

    #[tokio::test]
    async fn the_viewfinder_refuses_a_foreign_host() {
        let relay = Relay::new();
        relay.push_chunk(HEVC_IDR, Instant::now());
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(serve_annexb(listener, Arc::clone(&relay)));
        for request in [
            "GET /stream HTTP/1.1\r\nHost: evil.example\r\n\r\n".to_string(),
            format!("GET /stream HTTP/1.1\r\nHost: evil.example:{port}\r\n\r\n"),
            "GET /stream HTTP/1.1\r\n\r\n".to_string(),
        ] {
            let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            client.write_all(request.as_bytes()).await.unwrap();
            let mut response = String::new();
            tokio::time::timeout(READ_LIMIT, client.read_to_string(&mut response))
                .await
                .expect("a refused request must close the connection")
                .unwrap();
            assert!(
                response.starts_with("HTTP/1.1 421 Misdirected Request\r\n"),
                "{request:?}: {response}"
            );
        }
    }

    async fn viewfinder(relay: &Arc<Relay>) -> TcpStream {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(serve_annexb(listener, Arc::clone(relay)));
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        client
            .write_all(request(port, "127.0.0.1").as_bytes())
            .await
            .unwrap();
        client
    }

    /// Reads up to and including the blank line ending the response head.
    async fn read_head(client: &mut TcpStream) {
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            let mut byte = [0u8; 1];
            let n = tokio::time::timeout(READ_LIMIT, client.read(&mut byte))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(n, 1, "socket closed inside the response head");
            head.push(byte[0]);
        }
        assert_eq!(head, response_head());
    }

    /// The NAL types following each four-byte start code in `bytes`.
    fn nal_types(bytes: &[u8]) -> Vec<u8> {
        bytes
            .windows(5)
            .filter(|w| w[..4] == [0, 0, 0, 1])
            .map(|w| (w[4] >> 1) & 0x3f)
            .collect()
    }

    async fn read_some(client: &mut TcpStream, into: &mut Vec<u8>) -> usize {
        let mut chunk = vec![0u8; 64 * 1024];
        let n = tokio::time::timeout(READ_LIMIT, client.read(&mut chunk))
            .await
            .unwrap()
            .unwrap();
        into.extend_from_slice(&chunk[..n]);
        n
    }

    #[tokio::test]
    async fn viewfinder_client_gets_params_then_keyframe() {
        let relay = Relay::new();
        relay.push_chunk(&HEVC_IDR[..HEVC_IDR.len() / 2], Instant::now());
        let bootstrap_len: usize = relay
            .subscribe()
            .bootstrap
            .iter()
            .map(|au| au.data.len())
            .sum();
        assert!(bootstrap_len > 0);
        let mut client = viewfinder(&relay).await;
        read_head(&mut client).await;
        let mut body = Vec::new();
        while body.len() < bootstrap_len {
            assert!(read_some(&mut client, &mut body).await > 0, "closed early");
        }
        let types = nal_types(&body);
        assert_eq!(types[..3], [32, 33, 34], "VPS, SPS, PPS first: {types:?}");
        let first_slice = types.iter().find(|&&t| t <= 31).copied();
        assert!(
            first_slice.is_some_and(|t| (16..=21).contains(&t)),
            "an IRAP must come before any other slice: {types:?}"
        );
    }

    #[tokio::test]
    async fn early_joiner_gets_the_params_its_keyframe_decodes_with() {
        use crate::webcam::nal::Codec;
        let relay = Relay::new();
        let mut client = viewfinder(&relay).await;
        read_head(&mut client).await;
        let params = |tag: u8| {
            Some(ParamSets {
                codec: Codec::H265,
                nals: vec![vec![0x40, 0x01, tag]],
            })
        };
        let keyframe = [0, 0, 0, 1, 0x26, 0x01, 0xaf];
        relay.push_au(
            AccessUnit {
                data: keyframe.to_vec(),
                keyframe: true,
                params: params(0xaa),
                pts90k: 1,
            },
            Instant::now(),
        );
        // The params change before the client gets to the keyframe.
        relay.push_au(
            AccessUnit {
                data: vec![0, 0, 0, 1, 0x02, 0x01, 0xbb],
                keyframe: false,
                params: params(0xbb),
                pts90k: 2,
            },
            Instant::now(),
        );
        let expected = [&[0, 0, 0, 1, 0x40, 0x01, 0xaa][..], &keyframe].concat();
        let mut body = Vec::new();
        while body.len() < expected.len() {
            assert!(read_some(&mut client, &mut body).await > 0, "closed early");
        }
        assert_eq!(body[..expected.len()], expected);
    }

    #[tokio::test]
    async fn a_client_that_stops_reading_is_closed() {
        let relay = Relay::new();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        client
            .write_all(request(port, "127.0.0.1").as_bytes())
            .await
            .unwrap();
        let (socket, _) = listener.accept().await.unwrap();
        let served = tokio::spawn(serve_client(
            socket,
            Arc::clone(&relay),
            Duration::from_millis(200),
        ));
        tokio::time::sleep(Duration::from_millis(50)).await;
        // Far more than the socket buffers hold, and fewer AUs than would lag.
        relay.push_au(
            AccessUnit {
                data: vec![0, 0, 0, 1, 0x26, 0x01, 0xaf],
                keyframe: true,
                params: Some(ParamSets {
                    codec: crate::webcam::nal::Codec::H265,
                    nals: vec![vec![0x40, 0x01, 0xaa]],
                }),
                pts90k: 0,
            },
            Instant::now(),
        );
        for i in 1..200 {
            relay.push_au(
                AccessUnit {
                    data: vec![0; 256 * 1024],
                    keyframe: false,
                    params: None,
                    pts90k: i,
                },
                Instant::now(),
            );
        }
        tokio::time::timeout(Duration::from_secs(3), served)
            .await
            .expect("a client that stops reading must be closed")
            .unwrap();
        drop(client);
    }

    #[tokio::test]
    async fn client_joining_before_any_keyframe_waits_for_one() {
        let relay = Relay::new();
        let mut client = viewfinder(&relay).await;
        read_head(&mut client).await;
        // Skip the opening IDR AU's leading params and slice: start mid-GOP.
        let start = HEVC_IDR
            .windows(5)
            .position(|w| w[..4] == [0, 0, 0, 1] && (w[4] >> 1) & 0x3f == 1)
            .unwrap();
        relay.push_chunk(&HEVC_IDR[start..], Instant::now());
        let mut body = Vec::new();
        while nal_types(&body).len() < 2 {
            assert!(read_some(&mut client, &mut body).await > 0, "closed early");
        }
        assert_eq!(nal_types(&body)[0], 32, "first NAL must be the VPS");
    }

    #[tokio::test]
    async fn lagging_client_is_closed() {
        let relay = Relay::new();
        let mut client = viewfinder(&relay).await;
        read_head(&mut client).await;
        for i in 0..2_000 {
            relay.push_au(
                AccessUnit {
                    data: vec![0; 64 * 1024],
                    keyframe: false,
                    params: None,
                    pts90k: i,
                },
                Instant::now(),
            );
        }
        let drained = tokio::time::timeout(READ_LIMIT, async {
            let mut sink = Vec::new();
            client.read_to_end(&mut sink).await.map(|_| sink.len())
        })
        .await;
        assert!(drained
            .expect("a lagging client must be closed, not left hanging")
            .is_ok());
    }

    #[tokio::test]
    async fn pump_switches_to_new_session_without_closing_clients() {
        let relay = Relay::new();
        relay.push_chunk(HEVC_IDR, Instant::now());
        let bootstrap_len: usize = relay
            .subscribe()
            .bootstrap
            .iter()
            .map(|au| au.data.len())
            .sum();
        let mut client = viewfinder(&relay).await;
        read_head(&mut client).await;
        let mut bootstrap = Vec::new();
        while bootstrap.len() < bootstrap_len {
            assert!(
                read_some(&mut client, &mut bootstrap).await > 0,
                "closed early"
            );
        }
        assert_eq!(bootstrap.len(), bootstrap_len);

        // A new session: its stream starts afresh on an IDR.
        relay.discontinuity();
        relay.push_chunk(HEVC_IDR, Instant::now());
        let mut after = Vec::new();
        while !nal_types(&after).iter().any(|t| (16..=21).contains(t)) {
            assert!(
                read_some(&mut client, &mut after).await > 0,
                "closed after the reset"
            );
        }
        let mut probe = [0u8; 1];
        let still_open =
            tokio::time::timeout(Duration::from_millis(200), client.read(&mut probe)).await;
        assert!(
            !matches!(still_open, Ok(Ok(0))),
            "socket closed after the switch"
        );
    }

    use crate::luna::fake::{self, OnStart};

    const START: u16 = CODE_START_LIVE_STREAM;
    const STOP: u16 = CODE_STOP_LIVE_STREAM;

    async fn consumers(live: &LiveViewState) -> HashSet<Consumer> {
        live.inner.lock().await.consumers.clone()
    }

    #[tokio::test]
    async fn failed_start_sends_stop_and_drops_the_claim() {
        let live = LiveViewState::default();
        let (session, camera) = fake::connect(OnStart::HangUp).await;
        let result = live.acquire(Consumer::Viewfinder, session).await;
        assert!(result.is_err());
        assert_eq!(camera.wait_for(2).await, [START, STOP]);
        assert!(consumers(&live).await.is_empty());
    }

    #[tokio::test]
    async fn an_acquire_cancelled_mid_start_keeps_its_claim() {
        let live = Arc::new(LiveViewState::default());
        let (session, camera) = fake::connect(OnStart::Ignore).await;
        let pending = tokio::spawn({
            let live = Arc::clone(&live);
            let session = Arc::clone(&session);
            async move { live.acquire(Consumer::Webcam, session).await }
        });
        camera.wait_for(1).await;
        pending.abort();
        let _ = pending.await;
        assert_eq!(consumers(&live).await, set(&[Consumer::Webcam]));
        // So the release that follows still stops the camera.
        live.release(Consumer::Webcam).await;
        assert_eq!(camera.wait_for(2).await, [START, STOP]);
    }

    #[tokio::test]
    async fn restart_without_consumers_sends_nothing() {
        let live = LiveViewState::default();
        let (session, camera) = fake::connect(OnStart::Answer).await;
        live.restart(session).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(camera.codes().is_empty());
    }

    #[tokio::test]
    async fn restart_cycles_stop_then_start_and_drops_the_cache() {
        let live = LiveViewState::default();
        let (session, camera) = fake::connect(OnStart::Answer).await;
        live.acquire(Consumer::Webcam, Arc::clone(&session))
            .await
            .unwrap();
        live.relay().push_chunk(HEVC_IDR, Instant::now());
        assert!(!live.relay().subscribe().bootstrap.is_empty());
        live.restart(session).await.unwrap();
        assert_eq!(camera.wait_for(3).await, [START, STOP, START]);
        assert!(live.relay().subscribe().bootstrap.is_empty());
        assert_eq!(consumers(&live).await, set(&[Consumer::Webcam]));
    }

    #[tokio::test]
    async fn a_keyframe_sent_before_the_start_ack_survives_a_restart() {
        let mut assembler = crate::webcam::nal::AccessUnitAssembler::new();
        let mut pictures = assembler.push(HEVC_IDR, 0);
        pictures.extend(assembler.flush());
        assert!(pictures[0].keyframe);
        // The keyframe and the picture after it, so the keyframe is complete.
        let video = vec![pictures[0].data.clone(), pictures[1].data.clone()];
        let live = LiveViewState::default();
        let (session, camera) = fake::connect_streaming(OnStart::Answer, video).await;
        live.acquire(Consumer::Webcam, Arc::clone(&session))
            .await
            .unwrap();
        live.restart(session).await.unwrap();
        assert_eq!(camera.wait_for(3).await, [START, STOP, START]);
        for _ in 0..100 {
            let bootstrap = live.relay().subscribe().bootstrap;
            if bootstrap.len() > 1 {
                assert!(bootstrap[1].keyframe);
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the new stream's first keyframe was dropped");
    }

    #[tokio::test]
    async fn restart_on_a_new_session_switches_without_stopping_the_old() {
        let live = LiveViewState::default();
        let (old, old_camera) = fake::connect(OnStart::Answer).await;
        let (new, new_camera) = fake::connect(OnStart::Answer).await;
        live.acquire(Consumer::Webcam, old).await.unwrap();
        live.restart(Arc::clone(&new)).await.unwrap();
        assert_eq!(new_camera.wait_for(1).await, [START]);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(old_camera.codes(), [START]);
        // The pump now follows the new session: a further restart cycles it.
        live.restart(new).await.unwrap();
        assert_eq!(new_camera.wait_for(3).await, [START, STOP, START]);
    }

    #[tokio::test]
    async fn an_evicted_session_is_not_kept_alive() {
        let live = LiveViewState::default();
        let (session, camera) = fake::connect(OnStart::Answer).await;
        live.acquire(Consumer::Webcam, Arc::clone(&session))
            .await
            .unwrap();
        let weak = Arc::downgrade(&session);
        drop(session);
        assert!(
            weak.upgrade().is_none(),
            "the preview must not own the session"
        );
        // The pump ends with the session's stream.
        let pump = live
            .inner
            .lock()
            .await
            .pump
            .as_ref()
            .map(JoinHandle::is_finished);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let finished = live
            .inner
            .lock()
            .await
            .pump
            .as_ref()
            .map(JoinHandle::is_finished);
        assert!(pump.is_some() && finished == Some(true));
        // No STOP on a dead session.
        tokio::time::timeout(Duration::from_secs(1), live.release(Consumer::Webcam))
            .await
            .expect("release must not wait on a dead session");
        assert_eq!(camera.codes(), [START]);
    }

    fn set(consumers: &[Consumer]) -> HashSet<Consumer> {
        consumers.iter().copied().collect()
    }

    #[test]
    fn first_acquire_starts_the_stream() {
        let (after, command) = transition(&set(&[]), Change::Acquire(Consumer::Viewfinder));
        assert_eq!(after, set(&[Consumer::Viewfinder]));
        assert_eq!(command, Some(Command::Start));
    }

    #[test]
    fn second_acquire_sends_nothing() {
        let (after, command) = transition(
            &set(&[Consumer::Viewfinder]),
            Change::Acquire(Consumer::Webcam),
        );
        assert_eq!(after, set(&[Consumer::Viewfinder, Consumer::Webcam]));
        assert_eq!(command, None);
    }

    #[test]
    fn releasing_one_of_two_sends_nothing() {
        let (after, command) = transition(
            &set(&[Consumer::Viewfinder, Consumer::Webcam]),
            Change::Release(Consumer::Webcam),
        );
        assert_eq!(after, set(&[Consumer::Viewfinder]));
        assert_eq!(command, None);
    }

    #[test]
    fn releasing_the_last_stops_the_stream() {
        let (after, command) =
            transition(&set(&[Consumer::Webcam]), Change::Release(Consumer::Webcam));
        assert!(after.is_empty());
        assert_eq!(command, Some(Command::Stop));
    }

    #[test]
    fn releasing_an_absent_consumer_sends_nothing() {
        let (after, command) = transition(&set(&[]), Change::Release(Consumer::Viewfinder));
        assert!(after.is_empty());
        assert_eq!(command, None);
        let (after, command) = transition(
            &set(&[Consumer::Webcam]),
            Change::Release(Consumer::Viewfinder),
        );
        assert_eq!(after, set(&[Consumer::Webcam]));
        assert_eq!(command, None);
    }
}
