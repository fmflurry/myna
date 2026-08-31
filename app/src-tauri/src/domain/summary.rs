//! Summaries generated from a meeting's transcript via a JSON template.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

/// Pointer to a persisted summary: which template produced it, when, and
/// where its markdown lives on disk.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SummaryRef {
    pub template: String,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub path: PathBuf,
    /// Output language code (e.g. `"en"`, `"fr"`). Defaults to
    /// `myna_llm::DEFAULT_SUMMARY_LANGUAGE` when deserializing a
    /// `meeting.json` written before this field existed.
    #[serde(default = "default_summary_language")]
    pub language: String,
    /// Whether this summary was generated from a transcript that has since
    /// been replaced (e.g. by a re-transcribe). The markdown itself is
    /// never deleted when this flips to `true` — only the flag changes, so
    /// the UI can warn without silently destroying user-visible content.
    /// Defaults to `false` when deserializing a `meeting.json` written
    /// before this field existed.
    #[serde(default)]
    pub stale: bool,
}

impl SummaryRef {
    /// Returns a copy of this summary ref with `stale` replaced.
    pub fn with_stale(&self, stale: bool) -> Self {
        Self {
            stale,
            ..self.clone()
        }
    }
}

/// A generated summary's content, loaded from disk.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Summary {
    pub template: String,
    pub markdown: String,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub language: String,
}

/// Default used by [`SummaryRef::language`] when absent from stored JSON.
fn default_summary_language() -> String {
    myna_llm::DEFAULT_SUMMARY_LANGUAGE.to_string()
}
