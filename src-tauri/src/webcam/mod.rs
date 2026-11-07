//! Webcam mode: turns the camera's preview stream into something a capture
//! tool such as OBS can ingest.

pub mod nal;
pub mod relay;
pub mod server;
pub mod stall;
pub mod ts;

use std::future::Future;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::liveview::{Consumer, LiveViewState};
use crate::luna::{LunaState, Session};
use nal::{hevc_dimensions, Codec, ParamSets};
use relay::Relay;
use stall::{StallAction, StallTracker, STALL_AFTER};

/// How often the monitor checks the session and the video.
const MONITOR_TICK: Duration = Duration::from_secs(1);
/// First wait before retrying a failed acquire; doubles up to the cap.
const ACQUIRE_RETRY_FIRST: Duration = Duration::from_secs(2);
const ACQUIRE_RETRY_MAX: Duration = Duration::from_secs(30);

fn next_retry_wait(wait: Duration) -> Duration {
    (wait * 2).min(ACQUIRE_RETRY_MAX)
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum WebcamPhase {
    /// Webcam mode is off.
    Off,
    /// The camera was asked to stream; no video yet.
    Starting,
    Streaming,
    /// No video for a while; the monitor is restarting the preview.
    Stalled,
    /// Webcam mode is on, but the camera is not connected.
    Stopped,
}

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WebcamStatus {
    pub state: WebcamPhase,
    pub url: Option<String>,
    pub codec: Option<&'static str>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub clients: u32,
    pub seconds_since_frame: Option<f64>,
}

/// `last_video` counts only video since the webcam acquired the session.
pub fn phase(
    wanted: bool,
    connected: bool,
    last_video: Option<Instant>,
    stalled: bool,
    now: Instant,
) -> WebcamPhase {
    if !wanted {
        WebcamPhase::Off
    } else if !connected {
        WebcamPhase::Stopped
    } else if stalled {
        WebcamPhase::Stalled
    } else {
        match last_video {
            None => WebcamPhase::Starting,
            // Old video is a stall even before the tracker ticks on it.
            Some(at) if now.saturating_duration_since(at) >= STALL_AFTER => WebcamPhase::Stalled,
            Some(_) => WebcamPhase::Streaming,
        }
    }
}

fn codec_name(codec: Codec) -> &'static str {
    match codec {
        Codec::H265 => "H.265",
        Codec::H264 => "H.264",
    }
}

/// HEVC SPS NAL type.
const HEVC_SPS: u8 = 33;

/// Display size from the stream's SPS; H.265 only.
fn dimensions(params: &ParamSets) -> Option<(u32, u32)> {
    match params.codec {
        Codec::H265 => params
            .nals
            .iter()
            .find(|nal| nal.first().is_some_and(|b| (b >> 1) & 0x3f == HEVC_SPS))
            .and_then(|sps| hevc_dimensions(sps)),
        Codec::H264 => None,
    }
}

/// What the monitor knows, shared with the status command.
#[derive(Default, Debug)]
struct Health {
    /// The bound port while webcam mode is on.
    port: Option<u16>,
    /// The camera has a live session.
    connected: bool,
    /// The webcam holds the preview on that session.
    held: bool,
    /// When that session was acquired; older video does not count.
    since: Option<Instant>,
    stalled: bool,
}

fn status(health: &Health, relay: &Relay, clients: u32, now: Instant) -> WebcamStatus {
    let Some(port) = health.port else {
        return WebcamStatus {
            state: WebcamPhase::Off,
            url: None,
            codec: None,
            width: None,
            height: None,
            clients: 0,
            seconds_since_frame: None,
        };
    };
    let last_video = match (health.held, health.since) {
        (true, Some(since)) => relay.last_video().filter(|at| *at >= since),
        _ => None,
    };
    let params = last_video.and(relay.params());
    let size = params.as_ref().and_then(dimensions);
    WebcamStatus {
        state: phase(true, health.connected, last_video, health.stalled, now),
        url: Some(format!("http://127.0.0.1:{port}{}", server::OBS_PATH)),
        codec: params.as_ref().map(|p| codec_name(p.codec)),
        width: size.map(|(w, _)| w),
        height: size.map(|(_, h)| h),
        clients,
        seconds_since_frame: last_video.map(|at| now.saturating_duration_since(at).as_secs_f64()),
    }
}

/// Follows the camera session while webcam mode is on: holds the preview on
/// whichever session is live, and restarts it when the video stalls.
struct Monitor {
    health: Arc<StdMutex<Health>>,
    session: Option<Weak<Session>>,
    tracker: StallTracker,
    /// Latest video already given to the tracker.
    last_seen: Option<Instant>,
    retry: Option<Retry>,
}

/// A failed acquire on `session`: not tried again before `at`.
struct Retry {
    session: Weak<Session>,
    at: Instant,
    wait: Duration,
}

impl Monitor {
    /// `session` is the one the webcam already acquired, if any.
    fn new(health: Arc<StdMutex<Health>>, session: Option<&Arc<Session>>, now: Instant) -> Self {
        let mut monitor = Monitor {
            health,
            session: None,
            tracker: StallTracker::new(now),
            last_seen: None,
            retry: None,
        };
        if let Some(session) = session {
            monitor.held(session, now);
        }
        monitor
    }

    fn health(&self) -> std::sync::MutexGuard<'_, Health> {
        self.health.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn holds(&self, session: &Arc<Session>) -> bool {
        self.session
            .as_ref()
            .is_some_and(|held| Weak::ptr_eq(held, &Arc::downgrade(session)))
    }

    /// The webcam now holds the preview on `session`, from `now`.
    fn held(&mut self, session: &Arc<Session>, now: Instant) {
        self.session = Some(Arc::downgrade(session));
        self.tracker = StallTracker::new(now);
        self.last_seen = None;
        self.retry = None;
        let mut health = self.health();
        health.connected = true;
        health.held = true;
        health.since = Some(now);
        health.stalled = false;
    }

    /// One check: follow `current`, the live session, then watch its video.
    async fn step(&mut self, current: Option<Arc<Session>>, live: &LiveViewState, now: Instant) {
        let Some(session) = current else {
            self.retry = None;
            if self.session.take().is_some() {
                live.release(Consumer::Webcam).await;
            }
            let mut health = self.health();
            health.connected = false;
            health.held = false;
            health.stalled = false;
            return;
        };
        if !self.holds(&session) {
            // A new session: take the preview there. A failure is retried on
            // that session after a growing wait; a different session at once.
            let previous = self
                .retry
                .take()
                .filter(|retry| Weak::ptr_eq(&retry.session, &Arc::downgrade(&session)));
            if previous.as_ref().is_some_and(|retry| now < retry.at) {
                self.retry = previous;
                return;
            }
            match live.acquire(Consumer::Webcam, Arc::clone(&session)).await {
                Ok(()) => self.held(&session, now),
                Err(error) => {
                    log::warn!("webcam could not start the preview: {error}");
                    let wait =
                        previous.map_or(ACQUIRE_RETRY_FIRST, |retry| next_retry_wait(retry.wait));
                    self.retry = Some(Retry {
                        session: Arc::downgrade(&session),
                        at: now + wait,
                        wait,
                    });
                    self.session = None;
                    // Still connected: the phase reads starting, not stopped.
                    let mut health = self.health();
                    health.connected = true;
                    health.held = false;
                    health.since = None;
                    health.stalled = false;
                }
            }
            return;
        }
        let since = self.health().since;
        if let Some(at) = live
            .relay()
            .last_video()
            .filter(|at| since.map_or(true, |s| *at >= s))
            .filter(|at| self.last_seen.map_or(true, |seen| *at > seen))
        {
            self.last_seen = Some(at);
            self.tracker.on_video(at);
        }
        if self.tracker.tick(now) == StallAction::Restart {
            log::warn!("webcam video stalled; restarting the preview");
            if let Err(error) = live.restart(session).await {
                log::warn!("webcam preview restart failed: {error}");
            }
        }
        self.health().stalled = self.tracker.stalled();
    }
}

/// Where webcam mode finds the camera session and the shared preview.
trait Camera: Clone + Send + Sync + 'static {
    fn session(&self) -> impl Future<Output = Option<Arc<Session>>> + Send + '_;
    fn live(&self) -> &LiveViewState;
}

impl<R: Runtime> Camera for AppHandle<R> {
    async fn session(&self) -> Option<Arc<Session>> {
        self.state::<LunaState>().session().await
    }

    fn live(&self) -> &LiveViewState {
        self.state::<LiveViewState>().inner()
    }
}

/// Steps the monitor every tick until `cancel`, which is checked only
/// between steps so a restart in progress always completes.
async fn run_monitor<C: Camera>(camera: C, mut monitor: Monitor, cancel: CancellationToken) {
    let mut ticker = tokio::time::interval(MONITOR_TICK);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => return,
            _ = ticker.tick() => {}
        }
        let session = camera.session().await;
        monitor.step(session, camera.live(), Instant::now()).await;
    }
}

struct Running {
    server: JoinHandle<()>,
    monitor: JoinHandle<()>,
    cancel: CancellationToken,
}

#[derive(Default)]
pub struct WebcamState {
    /// Some while webcam mode is on. Locked across start and stop.
    running: Mutex<Option<Running>>,
    health: Arc<StdMutex<Health>>,
    /// Clients currently streaming.
    clients: Arc<AtomicU32>,
}

impl WebcamState {
    fn health(&self) -> std::sync::MutexGuard<'_, Health> {
        self.health.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn status(&self, relay: &Relay) -> WebcamStatus {
        status(
            &self.health(),
            relay,
            self.clients.load(Ordering::SeqCst),
            Instant::now(),
        )
    }

    async fn start<C: Camera>(&self, camera: C) -> Result<WebcamStatus, String> {
        let mut running = self.running.lock().await;
        let live = camera.live();
        if running.is_some() {
            return Ok(self.status(&live.relay()));
        }
        let session = camera
            .session()
            .await
            .ok_or_else(|| "camera is not connected".to_string())?;
        let listener = server::bind_webcam()
            .await
            .map_err(|e| format!("cannot open the webcam port: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("cannot read the webcam port: {e}"))?
            .port();
        live.acquire(Consumer::Webcam, Arc::clone(&session)).await?;

        self.health().port = Some(port);
        let monitor = Monitor::new(Arc::clone(&self.health), Some(&session), Instant::now());
        let relay = live.relay();
        let status = self.status(&relay);
        let cancel = CancellationToken::new();
        *running = Some(Running {
            server: tokio::spawn(server::serve_ts(listener, relay, Arc::clone(&self.clients))),
            monitor: tokio::spawn(run_monitor(camera, monitor, cancel.clone())),
            cancel,
        });
        Ok(status)
    }

    async fn stop(&self, live: &LiveViewState) {
        let mut running = self.running.lock().await;
        let Some(Running {
            server,
            monitor,
            cancel,
        }) = running.take()
        else {
            return;
        };
        // The monitor first, so it cannot re-acquire behind the release. It
        // finishes the step in progress rather than stopping mid-restart.
        cancel.cancel();
        let _ = monitor.await;
        // Awaited so the listener is closed, and the port free, on return.
        server.abort();
        let _ = server.await;
        *self.health() = Health::default();
        live.release(Consumer::Webcam).await;
    }
}

/// Longest a quit waits for the camera to be told to stop streaming.
const SHUTDOWN_LIMIT: Duration = Duration::from_secs(2);

/// Stops webcam mode and the viewfinder, so the camera is not left streaming
/// after the app quits. Best effort: gives up after `limit` rather than
/// hanging the quit on a camera that has stopped answering.
pub async fn shutdown_within(webcam: &WebcamState, live: &LiveViewState, limit: Duration) {
    let stopping = async {
        webcam.stop(live).await;
        live.release_all().await;
    };
    if tokio::time::timeout(limit, stopping).await.is_err() {
        log::warn!("the camera did not confirm STOP before quit");
    }
}

/// `shutdown_within` with the limit the quit path uses.
pub async fn shutdown(webcam: &WebcamState, live: &LiveViewState) {
    shutdown_within(webcam, live, SHUTDOWN_LIMIT).await;
}

/// Turns webcam mode on: binds the port, starts the camera's preview, and
/// follows the session until stopped. Calling it again returns the status.
#[tauri::command]
pub async fn luna_webcam_start<R: Runtime>(
    app: AppHandle<R>,
    webcam: State<'_, WebcamState>,
) -> Result<WebcamStatus, String> {
    webcam.start(app).await
}

/// Turns webcam mode off: closes the port and every client, and releases the
/// preview. Safe to call when already off.
#[tauri::command]
pub async fn luna_webcam_stop(
    live: State<'_, LiveViewState>,
    webcam: State<'_, WebcamState>,
) -> Result<(), String> {
    webcam.stop(&live).await;
    Ok(())
}

#[tauri::command]
pub async fn luna_webcam_status(
    live: State<'_, LiveViewState>,
    webcam: State<'_, WebcamState>,
) -> Result<WebcamStatus, String> {
    Ok(webcam.status(&live.relay()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::luna::fake::{self, OnStart};
    use crate::luna::{CODE_START_LIVE_STREAM as START, CODE_STOP_LIVE_STREAM as STOP};

    const HEVC_IDR: &[u8] = include_bytes!("../../tests/fixtures/hevc-idr.h265");

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn phase_off_when_not_wanted() {
        let now = Instant::now();
        assert_eq!(phase(false, true, Some(now), false, now), WebcamPhase::Off);
        assert_eq!(phase(false, false, None, true, now), WebcamPhase::Off);
    }

    #[test]
    fn phase_stopped_when_wanted_without_a_session() {
        let now = Instant::now();
        assert_eq!(
            phase(true, false, Some(now), false, now),
            WebcamPhase::Stopped
        );
        assert_eq!(phase(true, false, None, true, now), WebcamPhase::Stopped);
    }

    #[test]
    fn phase_starting_before_the_first_video() {
        let now = Instant::now();
        assert_eq!(phase(true, true, None, false, now), WebcamPhase::Starting);
    }

    #[test]
    fn phase_streaming_with_recent_video() {
        let now = Instant::now() + secs(60);
        assert_eq!(
            phase(true, true, Some(now), false, now),
            WebcamPhase::Streaming
        );
        let recent = now - STALL_AFTER + Duration::from_millis(1);
        assert_eq!(
            phase(true, true, Some(recent), false, now),
            WebcamPhase::Streaming
        );
    }

    #[test]
    fn phase_stalled_when_the_tracker_says_so() {
        let now = Instant::now() + secs(60);
        assert_eq!(phase(true, true, None, true, now), WebcamPhase::Stalled);
        assert_eq!(
            phase(true, true, Some(now - secs(20)), true, now),
            WebcamPhase::Stalled
        );
    }

    #[test]
    fn phase_stalled_once_video_is_old_before_the_tracker_ticks() {
        let now = Instant::now() + secs(60);
        assert_eq!(
            phase(true, true, Some(now - STALL_AFTER), false, now),
            WebcamPhase::Stalled
        );
        assert_eq!(
            phase(true, true, Some(now - secs(13)), false, now),
            WebcamPhase::Stalled,
            "old video never reads as starting"
        );
    }

    #[test]
    fn status_serialises_to_the_frontend_contract() {
        let status = WebcamStatus {
            state: WebcamPhase::Streaming,
            url: Some("http://127.0.0.1:49283/obs".into()),
            codec: Some("H.265"),
            width: Some(1280),
            height: Some(720),
            clients: 1,
            seconds_since_frame: Some(0.5),
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({
                "state": "streaming",
                "url": "http://127.0.0.1:49283/obs",
                "codec": "H.265",
                "width": 1280,
                "height": 720,
                "clients": 1,
                "secondsSinceFrame": 0.5,
            })
        );
        for (phase, name) in [
            (WebcamPhase::Off, "off"),
            (WebcamPhase::Starting, "starting"),
            (WebcamPhase::Stalled, "stalled"),
            (WebcamPhase::Stopped, "stopped"),
        ] {
            assert_eq!(serde_json::to_value(phase).unwrap(), name);
        }
    }

    #[test]
    fn status_reports_the_stream_and_ignores_video_from_before_the_session() {
        let relay = Relay::new();
        let start = Instant::now();
        relay.push_chunk(HEVC_IDR, start);
        let off = status(&Health::default(), &relay, 0, start);
        assert_eq!(off.state, WebcamPhase::Off);
        assert_eq!(off.url, None);
        assert_eq!(off.codec, None);

        let health = Health {
            port: Some(49283),
            connected: true,
            held: true,
            since: Some(start + secs(1)),
            stalled: false,
        };
        let starting = status(&health, &relay, 2, start + secs(2));
        assert_eq!(starting.state, WebcamPhase::Starting);
        assert_eq!(starting.seconds_since_frame, None);

        relay.push_chunk(HEVC_IDR, start + secs(3));
        let streaming = status(&health, &relay, 2, start + secs(4));
        assert_eq!(
            streaming,
            WebcamStatus {
                state: WebcamPhase::Streaming,
                url: Some("http://127.0.0.1:49283/obs".into()),
                codec: Some("H.265"),
                width: Some(1280),
                height: Some(720),
                clients: 2,
                seconds_since_frame: Some(1.0),
            }
        );
    }

    fn health() -> Arc<StdMutex<Health>> {
        Arc::new(StdMutex::new(Health {
            port: Some(1),
            ..Health::default()
        }))
    }

    fn snapshot(health: &Arc<StdMutex<Health>>) -> (bool, bool) {
        let health = health.lock().unwrap();
        (health.connected, health.stalled)
    }

    #[tokio::test]
    async fn monitor_follows_the_session_across_a_reconnect() {
        let live = LiveViewState::default();
        let health = health();
        let now = Instant::now();
        let mut monitor = Monitor::new(Arc::clone(&health), None, now);

        let (first, first_camera) = fake::connect(OnStart::Answer).await;
        monitor.step(Some(Arc::clone(&first)), &live, now).await;
        assert_eq!(first_camera.wait_for(1).await, [START]);
        assert_eq!(snapshot(&health), (true, false));

        monitor.step(None, &live, now + secs(1)).await;
        assert_eq!(first_camera.wait_for(2).await, [START, STOP]);
        assert_eq!(snapshot(&health), (false, false));

        let (second, second_camera) = fake::connect(OnStart::Answer).await;
        monitor
            .step(Some(Arc::clone(&second)), &live, now + secs(2))
            .await;
        assert_eq!(second_camera.wait_for(1).await, [START]);
        assert_eq!(snapshot(&health), (true, false));
        assert_eq!(first_camera.codes(), [START, STOP]);
    }

    #[tokio::test]
    async fn monitor_switches_to_a_new_session_without_seeing_none() {
        let live = LiveViewState::default();
        let health = health();
        let now = Instant::now();
        let (first, first_camera) = fake::connect(OnStart::Answer).await;
        live.acquire(Consumer::Webcam, Arc::clone(&first))
            .await
            .unwrap();
        let mut monitor = Monitor::new(Arc::clone(&health), Some(&first), now);
        monitor.step(Some(Arc::clone(&first)), &live, now).await;
        assert_eq!(first_camera.wait_for(1).await, [START]);

        let (second, second_camera) = fake::connect(OnStart::Answer).await;
        monitor
            .step(Some(Arc::clone(&second)), &live, now + secs(1))
            .await;
        assert_eq!(second_camera.wait_for(1).await, [START]);
        assert_eq!(
            first_camera.codes(),
            [START],
            "nothing is sent to the old session"
        );
    }

    #[tokio::test]
    async fn monitor_restarts_a_stalled_preview_and_clears_on_video() {
        let live = LiveViewState::default();
        let health = health();
        let now = Instant::now();
        let (session, camera) = fake::connect(OnStart::Answer).await;
        live.acquire(Consumer::Webcam, Arc::clone(&session))
            .await
            .unwrap();
        let mut monitor = Monitor::new(Arc::clone(&health), Some(&session), now);

        live.relay().push_chunk(HEVC_IDR, now + secs(5));
        monitor
            .step(Some(Arc::clone(&session)), &live, now + secs(5))
            .await;
        monitor
            .step(Some(Arc::clone(&session)), &live, now + secs(16))
            .await;
        assert_eq!(camera.codes(), [START]);
        assert_eq!(snapshot(&health), (true, false));

        monitor
            .step(Some(Arc::clone(&session)), &live, now + secs(17))
            .await;
        assert_eq!(camera.wait_for(3).await, [START, STOP, START]);
        assert_eq!(snapshot(&health), (true, true));

        live.relay().push_chunk(HEVC_IDR, now + secs(18));
        monitor
            .step(Some(Arc::clone(&session)), &live, now + secs(18))
            .await;
        assert_eq!(snapshot(&health), (true, false));
        assert_eq!(camera.codes().len(), 3);
    }

    #[tokio::test]
    async fn video_from_before_the_session_does_not_hold_off_a_stall() {
        let live = LiveViewState::default();
        let health = health();
        let now = Instant::now() + secs(100);
        live.relay().push_chunk(HEVC_IDR, now);
        let (session, camera) = fake::connect(OnStart::Answer).await;
        let mut monitor = Monitor::new(Arc::clone(&health), None, now + secs(1));
        monitor
            .step(Some(Arc::clone(&session)), &live, now + secs(1))
            .await;
        monitor
            .step(Some(Arc::clone(&session)), &live, now + secs(13))
            .await;
        assert_eq!(camera.wait_for(3).await, [START, STOP, START]);
    }

    #[tokio::test]
    async fn old_video_does_not_clear_a_stall() {
        let live = LiveViewState::default();
        let health = health();
        let now = Instant::now();
        let (session, camera) = fake::connect(OnStart::Answer).await;
        live.acquire(Consumer::Webcam, Arc::clone(&session))
            .await
            .unwrap();
        let mut monitor = Monitor::new(Arc::clone(&health), Some(&session), now);
        live.relay().push_chunk(HEVC_IDR, now + secs(1));
        monitor
            .step(Some(Arc::clone(&session)), &live, now + secs(1))
            .await;
        monitor
            .step(Some(Arc::clone(&session)), &live, now + secs(14))
            .await;
        assert_eq!(camera.wait_for(3).await, [START, STOP, START]);
        assert_eq!(snapshot(&health), (true, true));
        // No video since: the same last frame must not read as a recovery.
        monitor
            .step(Some(Arc::clone(&session)), &live, now + secs(15))
            .await;
        assert_eq!(snapshot(&health), (true, true));
    }

    #[test]
    fn acquire_retries_back_off_to_a_cap() {
        let mut wait = ACQUIRE_RETRY_FIRST;
        let mut waits = vec![wait];
        for _ in 0..5 {
            wait = next_retry_wait(wait);
            waits.push(wait);
        }
        assert_eq!(waits, [2, 4, 8, 16, 30, 30].map(secs));
    }

    #[tokio::test]
    async fn a_failing_acquire_waits_and_reports_starting() {
        let live = LiveViewState::default();
        let health = health();
        let now = Instant::now();
        let mut monitor = Monitor::new(Arc::clone(&health), None, now);
        let (session, camera) = fake::connect(OnStart::HangUp).await;
        monitor.step(Some(Arc::clone(&session)), &live, now).await;
        assert_eq!(camera.wait_for(1).await[0], START);
        // Within the wait: no new attempt (each would cost a command timeout).
        monitor
            .step(Some(Arc::clone(&session)), &live, now + secs(1))
            .await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        let starts = camera.codes().iter().filter(|c| **c == START).count();
        assert_eq!(starts, 1, "{:?}", camera.codes());
        {
            let health = health.lock().unwrap();
            assert!(health.connected && !health.held);
            assert_eq!(
                status(&health, &live.relay(), 0, now + secs(1)).state,
                WebcamPhase::Starting,
                "a session is present, so not stopped"
            );
        }

        // A different session is tried at once.
        let (second, second_camera) = fake::connect(OnStart::Answer).await;
        monitor
            .step(Some(Arc::clone(&second)), &live, now + secs(1))
            .await;
        assert_eq!(second_camera.wait_for(1).await, [START]);
        assert!(health.lock().unwrap().held);
    }

    #[derive(Clone)]
    struct TestCamera {
        session: Arc<Session>,
        live: Arc<LiveViewState>,
    }

    impl Camera for TestCamera {
        fn session(&self) -> impl Future<Output = Option<Arc<Session>>> + Send + '_ {
            std::future::ready(Some(Arc::clone(&self.session)))
        }

        fn live(&self) -> &LiveViewState {
            &self.live
        }
    }

    #[tokio::test]
    async fn stop_closes_the_port_before_returning() {
        let _fixed = server::FIXED_PORT.lock().await;
        let (session, camera) = fake::connect(OnStart::Answer).await;
        let source = TestCamera {
            session: Arc::clone(&session),
            live: Arc::new(LiveViewState::default()),
        };
        // The viewfinder keeps the preview, so the release sends nothing and
        // stop has no reason to yield on its own.
        source
            .live
            .acquire(Consumer::Viewfinder, session)
            .await
            .unwrap();
        let webcam = WebcamState::default();
        let first = webcam.start(source.clone()).await.unwrap();
        let fixed = format!(
            "http://127.0.0.1:{}{}",
            server::WEBCAM_PORT,
            server::OBS_PATH
        );
        if first.url.as_deref() != Some(fixed.as_str()) {
            eprintln!("skipped: port {} is held elsewhere", server::WEBCAM_PORT);
            webcam.stop(&source.live).await;
            return;
        }
        webcam.stop(&source.live).await;
        let second = webcam.start(source.clone()).await.unwrap();
        assert_eq!(second.url, first.url, "the listener must be closed by stop");
        webcam.stop(&source.live).await;
        assert_eq!(webcam.status(&source.live.relay()).state, WebcamPhase::Off);
        assert_eq!(camera.codes(), [START], "the viewfinder still holds it");
    }

    #[tokio::test]
    async fn shutdown_tells_the_camera_to_stop_and_clears_both_consumers() {
        let (session, camera) = fake::connect(OnStart::Answer).await;
        let live = LiveViewState::default();
        live.acquire(Consumer::Viewfinder, Arc::clone(&session))
            .await
            .unwrap();
        let webcam = WebcamState::default();
        shutdown(&webcam, &live).await;
        assert_eq!(camera.wait_for(2).await, [START, STOP]);
    }

    #[tokio::test]
    async fn shutdown_gives_up_on_a_camera_that_never_answers_stop() {
        let (session, camera) = fake::connect(OnStart::Ignore).await;
        let live = Arc::new(LiveViewState::default());
        let pending = tokio::spawn({
            let live = Arc::clone(&live);
            let session = Arc::clone(&session);
            async move { live.acquire(Consumer::Webcam, session).await }
        });
        camera.wait_for(1).await;
        pending.abort();
        let _ = pending.await;
        let began = Instant::now();
        shutdown_within(&WebcamState::default(), &live, Duration::from_millis(100)).await;
        assert!(began.elapsed() < Duration::from_secs(2));
        assert_eq!(camera.wait_for(2).await, [START, STOP]);
    }

    #[test]
    fn codec_names_match_the_frontend() {
        assert_eq!(codec_name(Codec::H265), "H.265");
        assert_eq!(codec_name(Codec::H264), "H.264");
    }
}
