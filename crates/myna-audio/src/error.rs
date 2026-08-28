//! Error type for `myna-audio`.
//!
//! The public API of this crate returns `Result<_, AudioError>` — never
//! `anyhow::Error` — because this crate is consumed across an IPC boundary
//! (Tauri commands serialize errors back to the frontend).

/// Errors produced by device enumeration, capture, resampling, and WAV I/O.
#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    /// No default input device is available on this host.
    #[error("no default input device is available")]
    NoDefaultDevice,

    /// A device was requested by name but could not be found.
    #[error("input device not found: {0}")]
    DeviceNotFound(String),

    /// The device does not support a required stream configuration.
    #[error("unsupported audio format: {0}")]
    UnsupportedFormat(String),

    /// An error occurred building or running a cpal stream.
    #[error("audio stream error: {0}")]
    Stream(String),

    /// An error occurred while resampling audio.
    #[error("resample error: {0}")]
    Resample(String),

    /// An error occurred while reading or writing a WAV file.
    #[error("wav error: {0}")]
    Wav(String),

    /// An underlying I/O error.
    #[error(transparent)]
    Io(#[from] std::io::Error),

    /// System-audio capture was requested but is unavailable on this
    /// platform or in this build.
    #[error("system audio unavailable: {0}")]
    SystemAudioUnavailable(String),

    /// System-audio capture was requested but the OS denied permission.
    #[error("system audio permission denied")]
    PermissionDenied,
}
