//! `myna-audio`: audio capture, resampling, recording, and level metering
//! for Myna.
//!
//! Every capture path normalizes to 16 kHz mono f32 ([`resample::TARGET_SAMPLE_RATE`]),
//! which is what both the Parakeet-TDT STT model and the Silero VAD segmenter
//! require. All public functions return [`error::AudioError`] rather than
//! `anyhow::Error`, since this crate is consumed across the Tauri IPC
//! boundary.

mod capture;
mod device;
mod error;
mod level;
mod mixer;
mod recorder;
mod resample;
mod system;
#[cfg(target_os = "macos")]
mod system_macos;
#[cfg(not(target_os = "macos"))]
mod system_stub;

pub use capture::{
    capture, capture_sources, is_system_audio_stalled, CaptureConfig, CaptureRequest,
    CaptureSource, RateLimitedQuery, TrackBlock,
};
pub use device::{
    default_input_device, default_output_device, list_input_devices, list_output_devices,
    DeviceInfo,
};
pub use error::AudioError;
pub use level::{rms, rms_dbfs, SILENCE_FLOOR_DBFS};
pub use mixer::{
    mix_into, DriftController, SampleRing, DRIFT_CHECK_INTERVAL, DRIFT_GAIN, MAX_DRIFT_ADJUST,
    MIX_GAIN, RENDERING_QUERY_MIN_INTERVAL, SYSTEM_RENDERING_SILENCE_TIMEOUT, SYSTEM_RING_CAPACITY,
    SYSTEM_STALL_TIMEOUT, TARGET_FILL_SAMPLES,
};
pub use recorder::{RecordingSpec, RecordingStats, WavRecorder};
pub use resample::{downmix_to_mono, Resampler, TARGET_SAMPLE_RATE};
pub use system::{
    list_system_audio_sources, request_system_audio_permission, system_audio_status,
    SystemAudioSource, SystemAudioStatus, ALL_OUTPUT_SOURCE_ID,
};
