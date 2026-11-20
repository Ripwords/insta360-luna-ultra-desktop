//! AirPods head tracking.
//!
//! macOS exposes the head orientation of motion-capable headphones (AirPods
//! Pro, AirPods Max, AirPods 3rd and 4th generation) through
//! `CMHeadphoneMotionManager`. This module starts and stops it and forwards
//! every sample to the webview as a `headtrack://pose` event, in degrees.
//! What to do with the pose — steering the gimbal — lives in the frontend,
//! next to the rest of the gimbal control.
//!
//! The first start shows macOS's Motion & Fitness prompt, worded by
//! `NSMotionUsageDescription` in Info.plist. Headphones in "hands-free" mode,
//! because they are also the selected microphone, send no motion at all; the
//! frontend says so when samples do not arrive.

use serde::Serialize;
use tauri::{AppHandle, Runtime};

/// The event every sample is emitted as.
pub const POSE_EVENT: &str = "headtrack://pose";

/// One head orientation, in degrees, in CoreMotion's convention: positive yaw
/// is turning left, positive pitch is looking up, positive roll is tilting
/// the head to the right.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct HeadPose {
    pub yaw: f64,
    pub pitch: f64,
    pub roll: f64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadTrackingStatus {
    /// This platform has a headphone motion API at all (macOS only).
    pub supported: bool,
    /// Motion & Fitness permission: "notDetermined", "restricted", "denied"
    /// or "authorized".
    pub authorization: String,
    /// Updates are running.
    pub active: bool,
}

pub(crate) fn authorization_name(raw: isize) -> &'static str {
    match raw {
        0 => "notDetermined",
        1 => "restricted",
        2 => "denied",
        3 => "authorized",
        _ => "unknown",
    }
}

const RADIANS_TO_DEGREES: f64 = 180.0 / std::f64::consts::PI;

pub(crate) fn pose_from_radians(yaw: f64, pitch: f64, roll: f64) -> HeadPose {
    HeadPose {
        yaw: yaw * RADIANS_TO_DEGREES,
        pitch: pitch * RADIANS_TO_DEGREES,
        roll: roll * RADIANS_TO_DEGREES,
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{authorization_name, pose_from_radians, HeadTrackingStatus, POSE_EVENT};
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2_core_motion::{CMDeviceMotion, CMHeadphoneMotionManager};
    use objc2_foundation::{NSError, NSOperationQueue};
    use std::sync::Mutex;
    use tauri::{AppHandle, Emitter, Runtime};

    struct Running {
        manager: Retained<CMHeadphoneMotionManager>,
        // Kept so the queue outlives the updates it delivers
        _queue: Retained<NSOperationQueue>,
    }

    // SAFETY: CMHeadphoneMotionManager and NSOperationQueue are thread-safe
    // Objective-C objects; the mutex below serialises our own use of them.
    unsafe impl Send for Running {}

    static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

    fn authorization() -> String {
        let raw = unsafe { CMHeadphoneMotionManager::authorizationStatus() };
        authorization_name(raw.0).to_string()
    }

    pub fn status() -> HeadTrackingStatus {
        let active = RUNNING.lock().unwrap().is_some();
        HeadTrackingStatus {
            supported: true,
            authorization: authorization(),
            active,
        }
    }

    pub fn start<R: Runtime>(app: AppHandle<R>) -> Result<HeadTrackingStatus, String> {
        let mut running = RUNNING.lock().unwrap();
        if running.is_none() {
            let manager = unsafe { CMHeadphoneMotionManager::new() };
            if !unsafe { manager.isDeviceMotionAvailable() } {
                return Err("This Mac does not support headphone motion.".into());
            }
            let queue = NSOperationQueue::new();
            let handler = RcBlock::new(move |motion: *mut CMDeviceMotion, _error: *mut NSError| {
                // SAFETY: CoreMotion passes either null or a valid object for
                // the duration of the call.
                let Some(motion) = (unsafe { motion.as_ref() }) else {
                    return;
                };
                let attitude = unsafe { motion.attitude() };
                let pose =
                    unsafe { pose_from_radians(attitude.yaw(), attitude.pitch(), attitude.roll()) };
                let _ = app.emit(POSE_EVENT, pose);
            });
            // CoreMotion copies the handler block, so ours can go out of scope.
            unsafe {
                manager
                    .startDeviceMotionUpdatesToQueue_withHandler(&queue, RcBlock::as_ptr(&handler));
            }
            running.replace(Running {
                manager,
                _queue: queue,
            });
        }
        drop(running);
        Ok(status())
    }

    pub fn stop() {
        if let Some(running) = RUNNING.lock().unwrap().take() {
            unsafe { running.manager.stopDeviceMotionUpdates() };
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::HeadTrackingStatus;
    use tauri::{AppHandle, Runtime};

    pub fn status() -> HeadTrackingStatus {
        HeadTrackingStatus {
            supported: false,
            authorization: "unknown".into(),
            active: false,
        }
    }

    pub fn start<R: Runtime>(_app: AppHandle<R>) -> Result<HeadTrackingStatus, String> {
        Err("Head tracking needs macOS.".into())
    }

    pub fn stop() {}
}

#[tauri::command]
pub async fn luna_headtrack_start<R: Runtime>(
    app: AppHandle<R>,
) -> Result<HeadTrackingStatus, String> {
    platform::start(app)
}

#[tauri::command]
pub async fn luna_headtrack_stop() -> Result<(), String> {
    platform::stop();
    Ok(())
}

#[tauri::command]
pub async fn luna_headtrack_status() -> Result<HeadTrackingStatus, String> {
    Ok(platform::status())
}

/// Stops updates as the app quits, so the headphones' sensors can idle.
pub fn shutdown() {
    platform::stop();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pose_is_reported_in_degrees() {
        let pose = pose_from_radians(
            std::f64::consts::FRAC_PI_2,
            -std::f64::consts::FRAC_PI_4,
            0.0,
        );
        assert!((pose.yaw - 90.0).abs() < 1e-9);
        assert!((pose.pitch + 45.0).abs() < 1e-9);
        assert_eq!(pose.roll, 0.0);
    }

    #[test]
    fn authorization_names_match_core_motion() {
        assert_eq!(authorization_name(0), "notDetermined");
        assert_eq!(authorization_name(1), "restricted");
        assert_eq!(authorization_name(2), "denied");
        assert_eq!(authorization_name(3), "authorized");
        assert_eq!(authorization_name(42), "unknown");
    }

    #[test]
    fn status_serialises_for_the_webview() {
        let status = HeadTrackingStatus {
            supported: true,
            authorization: "authorized".into(),
            active: false,
        };
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(
            json,
            r#"{"supported":true,"authorization":"authorized","active":false}"#
        );
    }
}
