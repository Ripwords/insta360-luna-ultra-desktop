//! Webcam mode: turns the camera's preview stream into something a capture
//! tool such as OBS can ingest.

pub mod nal;
pub mod relay;
// used by Task 8
#[allow(dead_code)]
pub mod ts;
