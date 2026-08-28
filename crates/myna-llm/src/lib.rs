//! `myna-llm`: summarization via Qwen2.5 (llama.cpp) for Myna.
//!
//! This crate implements template loading, validation, rendering, and
//! discovery (see the [`template`] module), plus model inference over the
//! safe `llama-cpp-2` wrapper with token streaming and cancellation (see
//! the [`engine`] module). The `myna-llm` CLI binary lives in `src/main.rs`.

mod engine;
mod error;
mod language;
mod template;

pub use engine::{Summarizer, SummaryOptions};
pub use error::LlmError;
pub use language::{
    label_for, resolve, SummaryLanguage, DEFAULT_SUMMARY_LANGUAGE, SUMMARY_LANGUAGES,
};
pub use template::{list_templates, RenderContext, Template, PLACEHOLDERS};
