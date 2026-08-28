//! Error types shared across `myna-llm`.

use std::path::PathBuf;

/// Errors produced by `myna-llm`.
///
/// Only the [`LlmError::Template`] and [`LlmError::Io`] variants are exercised
/// in this phase (template loading/validation). The remaining variants are
/// declared now so the inference module landing in a later phase does not
/// need to widen this enum's call sites.
#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    /// The requested model file does not exist on disk.
    #[error("model not found: {0}")]
    ModelNotFound(PathBuf),

    /// The model failed to load into llama.cpp.
    #[error("failed to load model: {0}")]
    Load(String),

    /// Failed to create or configure an inference context.
    #[error("failed to create context: {0}")]
    Context(String),

    /// The model has no chat template embedded in its GGUF metadata.
    #[error("model has no chat template")]
    NoChatTemplate,

    /// Tokenization of a prompt failed.
    #[error("failed to tokenize prompt: {0}")]
    Tokenize(String),

    /// Decoding tokens back to text failed.
    #[error("failed to decode tokens: {0}")]
    Decode(String),

    /// The in-flight operation was cancelled.
    #[error("operation was cancelled")]
    Cancelled,

    /// A summary template failed to load, parse, or validate.
    #[error("template error: {0}")]
    Template(String),

    /// An underlying I/O operation failed.
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
