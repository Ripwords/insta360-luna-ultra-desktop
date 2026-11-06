//! Fan-out point between the camera session and its consumers. Keeps the
//! pictures since the last keyframe so a late joiner starts on a clean one.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use tokio::sync::broadcast;

use super::nal::{AccessUnit, AccessUnitAssembler, ParamSets};

/// Live AUs a slow subscriber may fall behind by before it lags.
const BROADCAST_CAPACITY: usize = 256;
/// Largest GOP cache kept for late joiners.
const MAX_CACHE_BYTES: usize = 16 * 1024 * 1024;
const START_CODE: [u8; 4] = [0, 0, 0, 1];

pub struct Subscription {
    /// The params, then the pictures since the last keyframe; empty if no
    /// clean start point is cached.
    pub bootstrap: Vec<Arc<AccessUnit>>,
    pub live: broadcast::Receiver<Arc<AccessUnit>>,
}

struct State {
    assembler: AccessUnitAssembler,
    params: Option<ParamSets>,
    /// Keyframe first. Meaningful only while `cache_open`.
    cache: Vec<Arc<AccessUnit>>,
    cache_bytes: usize,
    /// False until a keyframe arrives, and after a clear.
    cache_open: bool,
    last_pts: Option<u64>,
    last_video: Option<Instant>,
}

impl State {
    fn close_cache(&mut self) {
        self.cache.clear();
        self.cache_bytes = 0;
        self.cache_open = false;
    }
}

pub struct Relay {
    created: Instant,
    state: Mutex<State>,
    tx: broadcast::Sender<Arc<AccessUnit>>,
}

impl Relay {
    pub fn new() -> Arc<Relay> {
        let (tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        Arc::new(Relay {
            created: Instant::now(),
            state: Mutex::new(State {
                assembler: AccessUnitAssembler::new(),
                params: None,
                cache: Vec::new(),
                cache_bytes: 0,
                cache_open: false,
                last_pts: None,
                last_video: None,
            }),
            tx,
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn push_chunk(&self, chunk: &[u8], now: Instant) {
        if chunk.is_empty() {
            return;
        }
        let micros = now.saturating_duration_since(self.created).as_micros();
        let pts = (micros * 9 / 100) as u64;
        let mut state = self.lock();
        state.last_video = Some(now);
        for au in state.assembler.push(chunk, pts) {
            self.publish(&mut state, au);
        }
    }

    #[cfg(test)]
    pub(crate) fn push_au(&self, au: AccessUnit, _now: Instant) {
        let mut state = self.lock();
        self.publish(&mut state, au);
    }

    /// Caches and broadcasts one AU. Called with the state lock held, so
    /// `subscribe` sees either all of it or none.
    fn publish(&self, state: &mut State, mut au: AccessUnit) {
        // Mux timestamps must never repeat, even if two AUs start in one chunk.
        if let Some(prev) = state.last_pts {
            au.pts90k = au.pts90k.max(prev + 1);
        }
        state.last_pts = Some(au.pts90k);

        if au.params.is_some() && au.params != state.params {
            state.params = au.params.clone();
            state.close_cache();
        }
        let au = Arc::new(au);
        if au.keyframe {
            state.close_cache();
            state.cache_open = true;
        }
        if state.cache_open {
            state.cache_bytes += au.data.len();
            state.cache.push(au.clone());
            if state.cache_bytes > MAX_CACHE_BYTES {
                state.close_cache();
            }
        }
        // No receivers is fine.
        let _ = self.tx.send(au);
    }

    pub fn subscribe(&self) -> Subscription {
        let state = self.lock();
        let live = self.tx.subscribe();
        let mut bootstrap = Vec::new();
        if let (true, Some(params), Some(first)) =
            (state.cache_open, &state.params, state.cache.first())
        {
            let mut data = Vec::new();
            for nal in &params.nals {
                data.extend_from_slice(&START_CODE);
                data.extend_from_slice(nal);
            }
            bootstrap.push(Arc::new(AccessUnit {
                data,
                keyframe: false,
                params: Some(params.clone()),
                pts90k: first.pts90k,
            }));
            bootstrap.extend(state.cache.iter().cloned());
        }
        Subscription { bootstrap, live }
    }

    pub fn params(&self) -> Option<ParamSets> {
        self.lock().params.clone()
    }

    // used by Task 8
    #[allow(dead_code)]
    pub fn last_video(&self) -> Option<Instant> {
        self.lock().last_video
    }

    /// Drops partial data when the session changes: the old session's
    /// in-flight pictures (the held-back one and any partial NAL) are
    /// discarded without flushing. Cache and clients stay.
    pub fn reset_assembler(&self) {
        self.lock().assembler = AccessUnitAssembler::new();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::webcam::nal::{Codec, hevc_dimensions};
    use std::time::Duration;

    const HEVC_IDR: &[u8] = include_bytes!("../../tests/fixtures/hevc-idr.h265");
    const HEVC_SWITCH: &[u8] = include_bytes!("../../tests/fixtures/hevc-switch.h265");

    /// Pictures the assembler keeps open after each push.
    const HELD_BACK: usize = 1;

    /// Reference AUs of a fixture, used to cut it into one chunk per picture.
    fn pictures(bytes: &[u8]) -> Vec<Vec<u8>> {
        let mut assembler = AccessUnitAssembler::new();
        let mut units = assembler.push(bytes, 0);
        units.extend(assembler.flush());
        units.into_iter().map(|unit| unit.data).collect()
    }

    fn feed(relay: &Relay, start: Instant, pics: &[Vec<u8>], from: usize, to: usize) {
        for (i, pic) in pics.iter().enumerate().take(to).skip(from) {
            relay.push_chunk(pic, start + Duration::from_millis(40 * i as u64 + 1));
        }
    }

    fn drain(sub: &mut Subscription) -> Vec<Arc<AccessUnit>> {
        let mut out = Vec::new();
        while let Ok(au) = sub.live.try_recv() {
            out.push(au);
        }
        out
    }

    fn sps_dimensions(params: &ParamSets) -> Option<(u32, u32)> {
        let sps = params.nals.iter().find(|nal| (nal[0] >> 1) & 0x3f == 33)?;
        hevc_dimensions(sps)
    }

    fn synthetic(keyframe: bool, len: usize, pts90k: u64) -> AccessUnit {
        AccessUnit {
            data: vec![0; len],
            keyframe,
            params: keyframe.then(|| ParamSets {
                codec: Codec::H265,
                nals: vec![vec![0x40, 0x01, 0xaa]],
            }),
            pts90k,
        }
    }

    #[test]
    fn subscriber_bootstrap_starts_at_keyframe_with_current_params() {
        let relay = Relay::new();
        let start = Instant::now();
        let pics = pictures(HEVC_IDR);
        // Stop mid-GOP, a few pictures after the keyframe at AU 30.
        feed(&relay, start, &pics, 0, 36);

        let sub = relay.subscribe();
        let params = relay.params().expect("params");
        assert_eq!(sps_dimensions(&params), Some((1280, 720)));
        assert!(!sub.bootstrap[0].keyframe);
        assert_eq!(sub.bootstrap[0].params.as_ref(), Some(&params));
        let expected: Vec<u8> = params
            .nals
            .iter()
            .flat_map(|nal| [&START_CODE[..], nal].concat())
            .collect();
        assert_eq!(sub.bootstrap[0].data, expected);
        assert!(sub.bootstrap[1].keyframe);
        assert_eq!(sub.bootstrap[0].pts90k, sub.bootstrap[1].pts90k);
        // The assembler holds back the last pushed picture, so AUs 0..=34 are out.
        assert_eq!(sub.bootstrap.len(), 1 + (35 - 30));
    }

    #[test]
    fn bootstrap_params_follow_a_resolution_switch() {
        let relay = Relay::new();
        let start = Instant::now();
        let pics = pictures(HEVC_SWITCH);
        feed(&relay, start, &pics, 0, pics.len());
        let sub = relay.subscribe();
        let params = sub.bootstrap[0].params.as_ref().expect("params");
        assert_eq!(sps_dimensions(params), Some((720, 1280)));
        assert!(sub.bootstrap[1].keyframe);
    }

    #[test]
    fn live_follows_bootstrap_without_gap_or_duplicate() {
        let relay = Relay::new();
        let start = Instant::now();
        let pics = pictures(HEVC_IDR);
        let mut everything = relay.subscribe();
        feed(&relay, start, &pics, 0, 36);

        let mut sub = relay.subscribe();
        feed(&relay, start, &pics, 36, pics.len());

        let all: Vec<u64> = drain(&mut everything).iter().map(|au| au.pts90k).collect();
        assert_eq!(all.len(), pics.len() - HELD_BACK);
        let first_cached = sub.bootstrap[1].pts90k;
        let from = all.iter().position(|&pts| pts == first_cached).unwrap();

        let mut joined: Vec<u64> = sub.bootstrap[1..].iter().map(|au| au.pts90k).collect();
        joined.extend(drain(&mut sub).iter().map(|au| au.pts90k));
        assert!(joined.windows(2).all(|w| w[0] < w[1]), "{joined:?}");
        assert_eq!(joined, all[from..]);
    }

    fn with_params(mut au: AccessUnit, tag: u8) -> AccessUnit {
        au.params = Some(ParamSets {
            codec: Codec::H265,
            nals: vec![vec![0x40, 0x01, tag]],
        });
        au
    }

    #[test]
    fn identical_repeated_params_keep_the_cache() {
        let relay = Relay::new();
        let now = Instant::now();
        relay.push_au(with_params(synthetic(true, 10, 1), 0xaa), now);
        relay.push_au(synthetic(false, 10, 2), now);
        relay.push_au(with_params(synthetic(false, 10, 3), 0xaa), now);
        relay.push_au(synthetic(false, 10, 4), now);
        assert_eq!(relay.subscribe().bootstrap.len(), 1 + 4);
    }

    #[test]
    fn different_params_on_a_non_key_au_close_the_cache_until_the_next_keyframe() {
        let relay = Relay::new();
        let now = Instant::now();
        relay.push_au(with_params(synthetic(true, 10, 1), 0xaa), now);
        relay.push_au(synthetic(false, 10, 2), now);
        relay.push_au(with_params(synthetic(false, 10, 3), 0xbb), now);
        assert!(relay.subscribe().bootstrap.is_empty());
        relay.push_au(with_params(synthetic(true, 10, 4), 0xbb), now);
        let bootstrap = relay.subscribe().bootstrap;
        assert_eq!(bootstrap.len(), 2);
        assert_eq!(bootstrap[0].params.as_ref().unwrap().nals[0][2], 0xbb);
    }

    #[test]
    fn pts_is_strictly_increasing_even_for_equal_arrival_times() {
        let relay = Relay::new();
        let mut sub = relay.subscribe();
        let now = Instant::now();
        relay.push_au(synthetic(true, 10, 500), now);
        relay.push_au(synthetic(false, 10, 500), now);
        relay.push_au(synthetic(false, 10, 100), now);
        let pts: Vec<u64> = drain(&mut sub).iter().map(|au| au.pts90k).collect();
        assert_eq!(pts, vec![500, 501, 502]);
    }

    #[test]
    fn cache_cap_closes_until_next_keyframe() {
        let relay = Relay::new();
        let now = Instant::now();
        relay.push_au(synthetic(true, 100, 1), now);
        for i in 0..5 {
            relay.push_au(synthetic(false, 4 * 1024 * 1024, 2 + i), now);
        }
        assert!(relay.subscribe().bootstrap.is_empty());
        relay.push_au(synthetic(true, 100, 10), now);
        assert_eq!(relay.subscribe().bootstrap.len(), 2);
    }

    #[test]
    fn changed_params_clear_the_cache_until_a_keyframe() {
        let relay = Relay::new();
        let now = Instant::now();
        relay.push_au(synthetic(true, 100, 1), now);
        relay.push_au(synthetic(false, 100, 2), now);
        let mut other = synthetic(false, 100, 3);
        other.params = Some(ParamSets {
            codec: Codec::H265,
            nals: vec![vec![0x40, 0x01, 0xbb]],
        });
        relay.push_au(other, now);
        assert!(relay.subscribe().bootstrap.is_empty());
        assert_eq!(relay.params().unwrap().nals[0][2], 0xbb);
    }

    #[test]
    fn pts_follows_arrival_time() {
        let relay = Relay::new();
        let start = Instant::now();
        let pics = pictures(HEVC_IDR);
        let mut sub = relay.subscribe();
        feed(&relay, start, &pics, 0, 10);
        let pts: Vec<u64> = drain(&mut sub).iter().map(|au| au.pts90k).collect();
        assert_eq!(pts.len(), 10 - HELD_BACK);
        assert!(pts.windows(2).all(|w| w[1] - w[0] == 3600), "{pts:?}");
    }

    #[test]
    fn last_video_tracks_non_empty_chunks_and_reset_keeps_the_cache() {
        let relay = Relay::new();
        let start = Instant::now();
        assert_eq!(relay.last_video(), None);
        let t1 = start + Duration::from_millis(5);
        relay.push_chunk(&[], t1);
        assert_eq!(relay.last_video(), None);
        let pics = pictures(HEVC_IDR);
        feed(&relay, start, &pics, 0, 3);
        let before = relay.subscribe().bootstrap.len();
        relay.reset_assembler();
        assert_eq!(relay.subscribe().bootstrap.len(), before);
        assert!(relay.last_video().is_some());
    }
}
