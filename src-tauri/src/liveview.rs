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
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::Mutex;
use tokio::task::{JoinHandle, JoinSet};

use crate::luna::{
    same_session, wire_field_varint, LunaState, Session, CODE_START_LIVE_STREAM,
    CODE_STOP_LIVE_STREAM,
};
use crate::webcam::relay::Relay;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const START_CODE: [u8; 4] = [0, 0, 0, 1];

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
    // used by Task 8
    #[allow(dead_code)]
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
    /// Created once; outlives camera sessions so clients survive a reconnect.
    relay: Arc<Relay>,
    consumers: HashSet<Consumer>,
    /// The session START was sent on, while its pump runs.
    session: Option<Arc<Session>>,
    pump: Option<JoinHandle<()>>,
    stats: Option<Arc<Stats>>,
    viewfinder: Option<(u16, JoinHandle<()>)>,
}

impl Preview {
    fn stop_pump(&mut self) {
        if let Some(pump) = self.pump.take() {
            pump.abort();
        }
        self.session = None;
        self.stats = None;
    }

    fn start_pump(&mut self, session: &Arc<Session>) {
        self.stop_pump();
        self.relay.reset_assembler();
        let stats = Arc::new(Stats::default());
        *stats.started.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
        self.pump = Some(tokio::spawn(pump(
            session.subscribe_stream(),
            Arc::clone(&self.relay),
            Arc::clone(&stats),
        )));
        self.stats = Some(stats);
        self.session = Some(Arc::clone(session));
    }
}

pub struct LiveViewState {
    inner: Mutex<Preview>,
}

impl Default for LiveViewState {
    fn default() -> Self {
        LiveViewState {
            inner: Mutex::new(Preview {
                relay: Relay::new(),
                consumers: HashSet::new(),
                session: None,
                pump: None,
                stats: None,
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

impl LiveViewState {
    /// Registers `consumer` and makes sure the camera is streaming on `session`.
    // used by Task 8
    #[allow(dead_code)]
    pub(crate) async fn acquire(
        &self,
        consumer: Consumer,
        session: Arc<Session>,
    ) -> Result<(), String> {
        let mut preview = self.inner.lock().await;
        acquire_locked(&mut preview, consumer, &session).await
    }

    /// Unregisters `consumer`; the last one out stops the camera stream.
    // used by Task 8
    #[allow(dead_code)]
    pub(crate) async fn release(&self, consumer: Consumer) {
        let mut preview = self.inner.lock().await;
        release_locked(&mut preview, consumer).await;
    }

    // used by Task 8
    #[allow(dead_code)]
    pub(crate) async fn relay(&self) -> Arc<Relay> {
        Arc::clone(&self.inner.lock().await.relay)
    }
}

async fn acquire_locked(
    preview: &mut Preview,
    consumer: Consumer,
    session: &Arc<Session>,
) -> Result<(), String> {
    let switched = !preview
        .session
        .as_ref()
        .is_some_and(|current| same_session(current, session));
    let (after, command) = transition(&preview.consumers, Change::Acquire(consumer));
    if switched {
        // Existing consumers carry over: the relay keeps their sockets open
        // and resyncs on the new session's next access unit.
        preview.start_pump(session);
        if let Err(error) = send_start(session).await {
            // Forget the session so the next acquire retries START.
            preview.stop_pump();
            return Err(error);
        }
    } else if command == Some(Command::Start) {
        send_start(session).await?;
    }
    preview.consumers = after;
    Ok(())
}

async fn release_locked(preview: &mut Preview, consumer: Consumer) {
    let (after, command) = transition(&preview.consumers, Change::Release(consumer));
    preview.consumers = after;
    if command == Some(Command::Stop) {
        let session = preview.session.clone();
        preview.stop_pump();
        if let Some(session) = session {
            let _ = session
                .send_command(CODE_STOP_LIVE_STREAM, &[], COMMAND_TIMEOUT)
                .await;
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
            // Chunks were dropped: discard the partial picture; the relay
            // resyncs at the next access unit start.
            Err(RecvError::Lagged(_)) => relay.reset_assembler(),
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
            accepted = listener.accept() => {
                let Ok((socket, _)) = accepted else { break };
                clients.spawn(serve_client(socket, Arc::clone(&relay)));
            }
            Some(_) = clients.join_next() => {}
        }
    }
}

fn params_annexb(relay: &Relay) -> Vec<u8> {
    let mut data = Vec::new();
    for nal in relay.params().map(|p| p.nals).unwrap_or_default() {
        data.extend_from_slice(&START_CODE);
        data.extend_from_slice(&nal);
    }
    data
}

/// One client: the head, then the bootstrap (params, then the pictures since
/// the last keyframe), then live pictures. A client that falls behind is
/// closed rather than continued mid-GOP; the page reconnects for a clean start.
async fn serve_client(mut socket: TcpStream, relay: Arc<Relay>) {
    // Read and discard the request; we serve one thing.
    let mut scratch = [0u8; 1024];
    let _ = socket.read(&mut scratch).await;
    let subscription = relay.subscribe();
    if socket.write_all(&response_head()).await.is_err() {
        return;
    }
    let mut started = !subscription.bootstrap.is_empty();
    for au in &subscription.bootstrap {
        if socket.write_all(&au.data).await.is_err() {
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
            // Nothing cached at join time: wait for a keyframe to start on.
            if !au.keyframe {
                continue;
            }
            if au.params.is_none() && socket.write_all(&params_annexb(&relay)).await.is_err() {
                return;
            }
            started = true;
        }
        if socket.write_all(&au.data).await.is_err() {
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
    acquire_locked(&mut preview, Consumer::Viewfinder, &session).await?;
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
            release_locked(&mut preview, Consumer::Viewfinder).await;
            return Err(error);
        }
    };
    let server = tokio::spawn(serve_annexb(listener, Arc::clone(&preview.relay)));
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
    release_locked(&mut preview, Consumer::Viewfinder).await;
    Ok(())
}

#[tauri::command]
pub async fn luna_liveview_stats(live: State<'_, LiveViewState>) -> Result<LiveViewStats, String> {
    let preview = live.inner.lock().await;
    let Some(stats) = preview.stats.as_ref() else {
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

    use crate::webcam::nal::AccessUnit;
    use tokio::net::TcpStream;

    const HEVC_IDR: &[u8] = include_bytes!("../tests/fixtures/hevc-idr.h265");
    const READ_LIMIT: Duration = Duration::from_secs(5);

    async fn viewfinder(relay: &Arc<Relay>) -> TcpStream {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(serve_annexb(listener, Arc::clone(relay)));
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        client
            .write_all(b"GET /stream HTTP/1.1\r\n\r\n")
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
        let mut client = viewfinder(&relay).await;
        read_head(&mut client).await;
        let mut body = Vec::new();
        while nal_types(&body).len() < 2 {
            assert!(read_some(&mut client, &mut body).await > 0, "closed early");
        }
        assert_eq!(nal_types(&body)[0], 32, "first NAL must be the VPS");
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
        relay.reset_assembler();
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
