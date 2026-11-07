//! Silent-stall detection for webcam mode. The camera can stop sending video
//! while its control session still answers (its screen went to sleep). After
//! [`STALL_AFTER`] without video the stream counts as stalled, and the monitor
//! tries a bounded number of STOP/START cycles.

use std::time::{Duration, Instant};

/// No video for this long means stalled.
pub const STALL_AFTER: Duration = Duration::from_secs(12);
/// Least time between two restarts.
pub const RESTART_GAP: Duration = Duration::from_secs(30);
/// Restarts tried per stall budget.
pub const MAX_RESTARTS: u8 = 2;
/// Continuous video for this long refills the budget.
pub const STEADY_FOR: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StallAction {
    None,
    Restart,
}

pub struct StallTracker {
    last_video: Instant,
    /// Start of the current unbroken run of video.
    steady_since: Option<Instant>,
    /// Restarts used from the current budget.
    restarts: u8,
    last_restart: Option<Instant>,
    stalled: bool,
}

impl StallTracker {
    /// Starts the clock at `now`, as if video had just arrived.
    pub fn new(now: Instant) -> Self {
        Self {
            last_video: now,
            steady_since: None,
            restarts: 0,
            last_restart: None,
            stalled: false,
        }
    }

    /// Video arrived at `now`.
    pub fn on_video(&mut self, now: Instant) {
        self.last_video = self.last_video.max(now);
        if self.stalled || self.steady_since.is_none() {
            self.stalled = false;
            self.steady_since = Some(now);
        }
        if self
            .steady_since
            .is_some_and(|since| now.saturating_duration_since(since) >= STEADY_FOR)
        {
            self.restarts = 0;
            self.last_restart = None;
        }
    }

    pub fn tick(&mut self, now: Instant) -> StallAction {
        if now.saturating_duration_since(self.last_video) < STALL_AFTER {
            return StallAction::None;
        }
        self.stalled = true;
        self.steady_since = None;
        let gap_over = self.last_restart.map_or(true, |last| {
            now.saturating_duration_since(last) >= RESTART_GAP
        });
        if self.restarts < MAX_RESTARTS && gap_over {
            self.restarts += 1;
            self.last_restart = Some(now);
            return StallAction::Restart;
        }
        StallAction::None
    }

    pub fn stalled(&self) -> bool {
        self.stalled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(base: Instant, secs: u64) -> Instant {
        base + Duration::from_secs(secs)
    }

    fn at_ms(base: Instant, ms: u64) -> Instant {
        base + Duration::from_millis(ms)
    }

    /// A tracker that stalled at 12 s and has used both restarts (12 s, 42 s).
    fn exhausted(base: Instant) -> StallTracker {
        let mut tracker = StallTracker::new(base);
        assert_eq!(tracker.tick(at(base, 12)), StallAction::Restart);
        assert_eq!(tracker.tick(at(base, 42)), StallAction::Restart);
        tracker
    }

    #[test]
    fn not_stalled_before_12s() {
        let base = Instant::now();
        let mut tracker = StallTracker::new(base);
        for ms in (0..12_000).step_by(1000).chain([11_999]) {
            assert_eq!(tracker.tick(at_ms(base, ms)), StallAction::None, "{ms} ms");
            assert!(!tracker.stalled(), "{ms} ms");
        }
        // Video keeps pushing the deadline out.
        tracker.on_video(at(base, 10));
        assert_eq!(tracker.tick(at(base, 21)), StallAction::None);
        assert!(!tracker.stalled());
    }

    #[test]
    fn stalls_after_12s_and_restarts_once() {
        let base = Instant::now();
        let mut tracker = StallTracker::new(base);
        tracker.on_video(at(base, 5));
        assert_eq!(tracker.tick(at_ms(base, 16_999)), StallAction::None);
        assert_eq!(tracker.tick(at(base, 17)), StallAction::Restart);
        assert!(tracker.stalled());
        for secs in 18..47 {
            assert_eq!(tracker.tick(at(base, secs)), StallAction::None, "{secs} s");
        }
    }

    #[test]
    fn second_restart_waits_30s() {
        let base = Instant::now();
        let mut tracker = StallTracker::new(base);
        assert_eq!(tracker.tick(at(base, 12)), StallAction::Restart);
        assert_eq!(tracker.tick(at_ms(base, 41_999)), StallAction::None);
        assert_eq!(tracker.tick(at(base, 42)), StallAction::Restart);
        assert!(tracker.stalled());
    }

    #[test]
    fn no_third_restart() {
        let base = Instant::now();
        let mut tracker = exhausted(base);
        for secs in (43..600).step_by(1) {
            assert_eq!(tracker.tick(at(base, secs)), StallAction::None, "{secs} s");
        }
        assert!(tracker.stalled(), "it keeps waiting, still stalled");
    }

    #[test]
    fn budget_resets_after_30s_of_video() {
        let base = Instant::now();
        // 29 s of video is not enough.
        let mut tracker = exhausted(base);
        for secs in 100..=129 {
            tracker.on_video(at(base, secs));
            assert_eq!(tracker.tick(at(base, secs)), StallAction::None);
        }
        assert_eq!(tracker.tick(at(base, 141)), StallAction::None);
        assert!(tracker.stalled());

        // 30 s is.
        let mut tracker = exhausted(base);
        for secs in 100..=130 {
            tracker.on_video(at(base, secs));
            assert_eq!(tracker.tick(at(base, secs)), StallAction::None);
        }
        assert_eq!(tracker.tick(at_ms(base, 141_999)), StallAction::None);
        assert_eq!(tracker.tick(at(base, 142)), StallAction::Restart);
        assert_eq!(tracker.tick(at(base, 171)), StallAction::None);
        assert_eq!(tracker.tick(at(base, 172)), StallAction::Restart);
        assert_eq!(tracker.tick(at(base, 202)), StallAction::None);
    }

    #[test]
    fn video_after_stall_clears_stalled() {
        let base = Instant::now();
        let mut tracker = StallTracker::new(base);
        assert_eq!(tracker.tick(at(base, 12)), StallAction::Restart);
        assert!(tracker.stalled());
        tracker.on_video(at(base, 13));
        assert!(!tracker.stalled());
        assert_eq!(tracker.tick(at(base, 14)), StallAction::None);
        // Stalling again inside the gap waits for it: the second restart is
        // 30 s after the first, not at the new stall.
        assert_eq!(tracker.tick(at(base, 25)), StallAction::None);
        assert!(tracker.stalled());
        assert_eq!(tracker.tick(at(base, 41)), StallAction::None);
        assert_eq!(tracker.tick(at(base, 42)), StallAction::Restart);
    }
}
