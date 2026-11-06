//! Webcam mode: turns the camera's preview stream into something a capture
//! tool such as OBS can ingest.

pub mod nal;
pub mod relay;
pub mod server;
pub mod stall;
pub mod ts;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::liveview::{Consumer, LiveViewState};
use crate::luna::{LunaState, Session};
use nal::{hevc_dimensions, Codec, ParamSets};
use relay::Relay;
use stall::{StallAction, StallTracker, STALL_AFTER};

/// How often the monitor checks the session and the video.
const MONITOR_TICK: Duration = Duration::from_secs(1);

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
    } else if last_video.is_some_and(|at| now.saturating_duration_since(at) < STALL_AFTER) {
        WebcamPhase::Streaming
    } else {
        // No video yet, or none for a moment the tracker has not ticked on.
        WebcamPhase::Starting
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
    /// The webcam holds the preview on a live session.
    connected: bool,
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
    let last_video = match (health.connected, health.since) {
        (true, Some(since)) => relay.last_video().filter(|at| *at >= since),
        _ => None,
    };
    let params = last_video.and(relay.params());
    let size = params.as_ref().and_then(dimensions);
    WebcamStatus {
        state: phase(true, health.connected, last_video, health.stalled, now),
        url: Some(format!("http://127.0.0.1:{port}{}", server::WEBCAM_PATH)),
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
}

impl Monitor {
    /// `session` is the one the webcam already acquired, if any.
    fn new(health: Arc<StdMutex<Health>>, session: Option<&Arc<Session>>, now: Instant) -> Self {
        let mut monitor = Monitor {
            health,
            session: None,
            tracker: StallTracker::new(now),
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
        let mut health = self.health();
        health.connected = true;
        health.since = Some(now);
        health.stalled = false;
    }

    /// One check: follow `current`, the live session, then watch its video.
    async fn step(&mut self, current: Option<Arc<Session>>, live: &LiveViewState, now: Instant) {
        let Some(session) = current else {
            if self.session.take().is_some() {
                live.release(Consumer::Webcam).await;
            }
            let mut health = self.health();
            health.connected = false;
            health.stalled = false;
            return;
        };
        if !self.holds(&session) {
            // A new session: take the preview there. On failure the next
            // tick tries again.
            match live.acquire(Consumer::Webcam, Arc::clone(&session)).await {
                Ok(()) => self.held(&session, now),
                Err(error) => {
                    log::warn!("webcam could not start the preview: {error}");
                    self.session = None;
                    self.health().connected = false;
                }
            }
            return;
        }
        let since = self.health().since;
        if let Some(at) = live
            .relay()
            .last_video()
            .filter(|at| since.map_or(true, |s| *at >= s))
        {
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

async fn run_monitor<R: Runtime>(app: AppHandle<R>, mut monitor: Monitor) {
    let mut ticker = tokio::time::interval(MONITOR_TICK);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        let session = app.state::<LunaState>().session().await;
        let live = app.state::<LiveViewState>();
        monitor.step(session, &live, Instant::now()).await;
    }
}

struct Running {
    server: JoinHandle<()>,
    monitor: JoinHandle<()>,
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
}

/// Turns webcam mode on: binds the port, starts the camera's preview, and
/// follows the session until stopped. Calling it again returns the status.
#[tauri::command]
pub async fn luna_webcam_start<R: Runtime>(
    app: AppHandle<R>,
    luna: State<'_, LunaState>,
    live: State<'_, LiveViewState>,
    webcam: State<'_, WebcamState>,
) -> Result<WebcamStatus, String> {
    let mut running = webcam.running.lock().await;
    if running.is_some() {
        return Ok(webcam.status(&live.relay()));
    }
    let session = luna
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

    webcam.health().port = Some(port);
    let monitor = Monitor::new(Arc::clone(&webcam.health), Some(&session), Instant::now());
    *running = Some(Running {
        server: tokio::spawn(server::serve_ts(
            listener,
            live.relay(),
            Arc::clone(&webcam.clients),
        )),
        monitor: tokio::spawn(run_monitor(app, monitor)),
    });
    Ok(webcam.status(&live.relay()))
}

/// Turns webcam mode off: closes the port and every client, and releases the
/// preview. Safe to call when already off.
#[tauri::command]
pub async fn luna_webcam_stop(
    live: State<'_, LiveViewState>,
    webcam: State<'_, WebcamState>,
) -> Result<(), String> {
    let mut running = webcam.running.lock().await;
    let Some(Running { server, monitor }) = running.take() else {
        return Ok(());
    };
    // The monitor first, so it cannot re-acquire behind the release.
    monitor.abort();
    server.abort();
    *webcam.health() = Health::default();
    live.release(Consumer::Webcam).await;
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
    fn status_serialises_to_the_frontend_contract() {
        let status = WebcamStatus {
            state: WebcamPhase::Streaming,
            url: Some("http://127.0.0.1:49283/webcam.ts".into()),
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
                "url": "http://127.0.0.1:49283/webcam.ts",
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
                url: Some("http://127.0.0.1:49283/webcam.ts".into()),
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

    #[test]
    fn codec_names_match_the_frontend() {
        assert_eq!(codec_name(Codec::H265), "H.265");
        assert_eq!(codec_name(Codec::H264), "H.264");
    }
}
