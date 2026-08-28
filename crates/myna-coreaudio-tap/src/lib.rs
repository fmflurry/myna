//! Safe, minimal bindings for macOS Core Audio process taps.
//!
//! A process tap captures one process's (or every process's) audio output
//! directly from the HAL, gated by the `kTCCServiceAudioCapture` TCC
//! service — a distinct, audio-only permission from Screen Recording, which
//! is what capturing system audio via ScreenCaptureKit requires instead.
//!
//! This crate is deliberately narrow: it exists only to wrap the handful of
//! `unsafe` Core Audio calls needed for [`ProcessTapCapture`] behind a safe,
//! RAII-cleaned-up API, plus the small set of read-only queries
//! ([`AudioProcess::list`], [`translate_pid`], [`is_process_running_output`])
//! that a caller needs to pick what to tap and to detect a stalled tap. It
//! is the one crate in the Myna workspace exempted from the workspace's
//! `unsafe_code = "forbid"` lint — see its `Cargo.toml` for why.
//!
//! The only consumer is `crates/myna-audio/src/system_macos.rs`.
//!
//! # Why the actual sample rate can't be assumed
//!
//! Unlike ScreenCaptureKit (which resamples to whatever rate is requested),
//! a Core Audio tap delivers audio at its aggregate device's native rate —
//! typically the current output device's nominal rate, which varies by
//! hardware (48 kHz and 44.1 kHz are both common). [`ProcessTapCapture::start`]
//! reads that rate from the tap's own aggregate device, after the tap exists
//! but before the IOProc starts, and returns it as part of [`CapturedFormat`]
//! rather than letting a caller assume a fixed constant.

mod aggregate;
mod process;
mod tap;
mod version;

pub use objc2_core_audio::AudioObjectID;
pub use process::{is_process_running_output, translate_pid, AudioProcess};
pub use tap::{CapturedFormat, ProcessTapCapture, TapError, TapScope};
pub use version::is_macos_at_least;
