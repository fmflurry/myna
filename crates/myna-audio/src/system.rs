//! System-audio availability status, permission requests, and capture
//! dispatch.
//!
//! This is the **only** file in this crate that branches on target
//! platform for system-audio support. [`crate::system_macos`] backs macOS;
//! [`crate::system_stub`] backs every other platform (and used to back
//! macOS too, before a real backend existed).

use serde::Serialize;

use crate::error::AudioError;

#[cfg(target_os = "macos")]
use crate::system_macos as backend;
#[cfg(not(target_os = "macos"))]
use crate::system_stub as backend;

/// Opaque handle to a live platform system-audio capture, re-exported here
/// (rather than named directly) so [`crate::capture`] can hold one — e.g. to
/// rebuild it after a detected stall — without itself branching on target
/// platform. Every method this crate's capture pipeline needs is duck-typed
/// identically across [`crate::system_macos::SystemAudioCapture`] and
/// [`crate::system_stub::SystemAudioCapture`].
pub(crate) type SystemAudioHandle = backend::SystemAudioCapture;

/// Whether system-audio capture is currently usable on this machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SystemAudioStatus {
    /// System audio can be captured now.
    Available,
    /// The OS denied (or has not yet granted) permission.
    PermissionDenied { restart_required: bool },
    /// System audio capture is not available, e.g. unsupported platform or
    /// OS version.
    Unavailable { reason: String },
    /// Permission state genuinely cannot be determined without attempting a
    /// capture. Some platform backends (Core Audio process taps on macOS)
    /// have no public preflight API for their TCC service — only a real
    /// capture attempt observes whether it's granted. Never returned once a
    /// capture has actually run in this process; see the macOS backend's
    /// module docs.
    Unknown,
}

/// Stable id for the synthetic "capture all system output" source —
/// [`list_system_audio_sources`]'s first entry, always.
pub const ALL_OUTPUT_SOURCE_ID: &str = "system:all";

/// Display name for [`ALL_OUTPUT_SOURCE_ID`].
pub(crate) const ALL_OUTPUT_SOURCE_NAME: &str = "All system audio";

/// One system-audio source that can be captured: either the synthetic
/// "all system output" source ([`ALL_OUTPUT_SOURCE_ID`]), or one specific
/// running application.
///
/// No field here ever names a platform API — `id` is an opaque string a
/// caller passes back to [`crate::capture::capture_sources`] unchanged; it
/// never leaks e.g. a raw `SCRunningApplication` pointer or Core Graphics
/// type name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SystemAudioSource {
    pub id: String,
    pub name: String,
}

impl SystemAudioSource {
    /// The synthetic "capture all system output" source.
    pub(crate) fn all_output() -> Self {
        Self {
            id: ALL_OUTPUT_SOURCE_ID.to_string(),
            name: ALL_OUTPUT_SOURCE_NAME.to_string(),
        }
    }
}

/// Reports whether system-audio capture is currently available, without
/// prompting the user.
pub fn system_audio_status() -> SystemAudioStatus {
    backend::system_audio_status()
}

/// Prompts the OS to grant system-audio capture permission, if the platform
/// supports such a prompt, and returns the resulting status.
pub fn request_system_audio_permission() -> SystemAudioStatus {
    backend::request_system_audio_permission()
}

/// Lists the system-audio sources capturable on this machine: the synthetic
/// all-output source ([`ALL_OUTPUT_SOURCE_ID`]) first, then one entry per
/// running application the platform backend can enumerate.
///
/// On a platform (or in a state) with no per-application enumeration, the
/// backend contributes no extra entries, so callers always get at least the
/// all-output entry back — never an error and never an empty vec.
pub fn list_system_audio_sources() -> Vec<SystemAudioSource> {
    let mut sources = vec![SystemAudioSource::all_output()];
    sources.extend(backend::list_running_application_sources());
    sources
}

/// Starts capturing system audio on whatever backend this platform has,
/// delivering mono f32 PCM to `on_pcm` at the sample rate reported in the
/// returned `u32` — the backend's *actual* rate, discovered at capture
/// start rather than assumed: a platform backend is never guaranteed to
/// deliver any particular fixed rate (Core Audio process taps on macOS
/// deliver whatever rate the tapped audio hardware natively runs at, which
/// varies by machine). Callers must build any resampler from this returned
/// value, not a compile-time constant.
///
/// `system_source` selects which [`SystemAudioSource::id`] to capture from;
/// `None` selects all system output. An id that can no longer be resolved
/// to a live source when capture actually starts falls back to all-output
/// rather than failing — the returned [`SystemAudioSource`] reports which
/// source was actually captured, so callers can detect that fallback.
///
/// [`crate::capture`] is the only caller. `on_pcm` runs on a backend-owned
/// thread or dispatch queue — never the calling thread — and must not
/// block.
pub(crate) fn start_system_audio_capture(
    system_source: Option<&str>,
    on_pcm: impl FnMut(&[f32]) + Send + 'static,
) -> Result<(SystemAudioHandle, SystemAudioSource, u32), AudioError> {
    backend::SystemAudioCapture::start(system_source, on_pcm)
}
