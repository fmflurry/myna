//! Fallback system-audio backend.
//!
//! Backs every platform except macOS: [`crate::system`]'s `cfg` dispatch
//! swaps in [`crate::system_macos`] there instead.

use crate::error::AudioError;
use crate::system::{SystemAudioBlock, SystemAudioSource, SystemAudioStatus};

/// Reason string reported while no platform backend is implemented.
const NOT_IMPLEMENTED_REASON: &str = "system audio capture is not implemented on this platform";

pub(crate) fn system_audio_status() -> SystemAudioStatus {
    SystemAudioStatus::Unavailable {
        reason: NOT_IMPLEMENTED_REASON.to_string(),
    }
}

pub(crate) fn request_system_audio_permission() -> SystemAudioStatus {
    system_audio_status()
}

/// No per-application enumeration on this platform: [`crate::system`]'s
/// [`crate::system::list_system_audio_sources`] still reports the
/// all-output entry it adds itself, so callers always see at least one
/// source.
pub(crate) fn list_running_application_sources() -> Vec<SystemAudioSource> {
    Vec::new()
}

/// Placeholder capture handle for platforms with no real backend:
/// [`SystemAudioCapture::start`] always fails, so a live instance never
/// exists.
pub(crate) struct SystemAudioCapture;

impl SystemAudioCapture {
    pub(crate) fn start(
        _system_source: Option<&str>,
        _on_pcm: impl FnMut(&SystemAudioBlock<'_>) + Send + 'static,
    ) -> Result<(Self, SystemAudioSource, u32), AudioError> {
        Err(AudioError::SystemAudioUnavailable(
            NOT_IMPLEMENTED_REASON.to_string(),
        ))
    }

    pub(crate) fn stop(self) -> Result<(), AudioError> {
        Ok(())
    }

    /// Stall-recovery probe duck-typed with [`crate::system_macos::SystemAudioCapture`]'s
    /// method of the same name. Never actually called: [`SystemAudioCapture::start`]
    /// always fails on this platform, so no live instance ever exists.
    pub(crate) fn is_any_tapped_process_rendering_output(&self) -> bool {
        false
    }
}
