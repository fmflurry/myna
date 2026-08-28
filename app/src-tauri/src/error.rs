//! App-wide error taxonomy for `myna-app`.
//!
//! Every variant maps to a stable `SCREAMING_SNAKE_CASE` code via the
//! hand-written [`serde::Serialize`] impl below, so the Angular UI can
//! switch on `error.code` instead of parsing prose out of `error.message`.

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// Errors that can surface anywhere in the Myna desktop app.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// An underlying I/O operation failed.
    #[error(transparent)]
    Io(#[from] std::io::Error),

    /// The meeting store failed to read, write, or parse on-disk state.
    #[error("store error: {0}")]
    Store(String),

    /// Speech-to-text failed.
    #[error(transparent)]
    Stt(#[from] myna_stt::SttError),

    /// Summarization failed.
    #[error(transparent)]
    Llm(#[from] myna_llm::LlmError),

    /// Audio capture failed.
    #[error(transparent)]
    Audio(#[from] myna_audio::AudioError),

    /// The requested resource does not exist.
    #[error("not found: {0}")]
    NotFound(String),

    /// The requested operation cannot run because a conflicting one is
    /// already in flight.
    #[error("busy: {0}")]
    Busy(&'static str),

    /// One or more required models are missing from disk.
    #[error("missing models: {0:?}")]
    ModelsMissing(Vec<String>),

    /// A filesystem path was invalid or could not be resolved.
    #[error("path error: {0}")]
    Path(String),
}

impl AppError {
    /// Stable machine-readable code exposed to the UI, in
    /// `SCREAMING_SNAKE_CASE`.
    fn code(&self) -> &'static str {
        match self {
            AppError::Io(_) => "IO",
            AppError::Store(_) => "STORE",
            AppError::Stt(_) => "STT",
            AppError::Llm(_) => "LLM",
            AppError::Audio(_) => "AUDIO",
            AppError::NotFound(_) => "NOT_FOUND",
            AppError::Busy(_) => "BUSY",
            AppError::ModelsMissing(_) => "MODELS_MISSING",
            AppError::Path(_) => "PATH",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}
