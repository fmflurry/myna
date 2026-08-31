//! Error type for `myna-stt`.
//!
//! Every fallible public function in this crate returns `Result<_, SttError>`
//! rather than `anyhow::Error`, matching the convention set by `myna-audio`.

use std::path::PathBuf;

/// Errors produced by model loading, decoding, VAD segmentation, and WAV I/O.
#[derive(Debug, thiserror::Error)]
pub enum SttError {
    /// A required model artifact was missing on disk.
    #[error("model artifact not found: {0}")]
    ModelNotFound(PathBuf),

    /// `sherpa_onnx::OfflineRecognizer::create` returned `None`.
    #[error("failed to initialize the offline recognizer")]
    RecognizerInit,

    /// `sherpa_onnx::VoiceActivityDetector::create` returned `None`.
    #[error("failed to initialize the voice activity detector")]
    VadInit,

    /// `sherpa_onnx::OfflineSpeakerDiarization::create` returned `None`.
    #[error("failed to initialize the offline speaker diarizer")]
    DiarizeInit,

    /// A `decoding_method` outside `engine::ALLOWED_DECODING_METHODS` was
    /// requested. Rejected before reaching sherpa-onnx, which calls
    /// `exit(-1)` on an unrecognized value instead of returning an error.
    #[error(
        "invalid decoding method {0:?}: expected one of \"greedy_search\", \"modified_beam_search\""
    )]
    InvalidDecodingMethod(String),

    /// Decoding produced no usable result.
    #[error("decode error: {0}")]
    Decode(String),

    /// An error occurred while reading a WAV file.
    #[error("wav error: {0}")]
    Wav(String),

    /// An underlying audio capture error.
    #[error(transparent)]
    Audio(#[from] myna_audio::AudioError),
}
