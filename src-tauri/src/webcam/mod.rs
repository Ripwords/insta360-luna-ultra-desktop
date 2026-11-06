//! Webcam mode: turns the camera's preview stream into something a capture
//! tool such as OBS can ingest.

// Consumed by the relay in the next task.
#![allow(dead_code)]

pub mod nal;
pub mod relay;
