//! The `Meeting` aggregate: a single recorded, transcribed, and summarized
//! session.
//!
//! Every mutation returns a new `Meeting` rather than mutating in place —
//! there are no `&mut self` setters on this type.

use std::path::PathBuf;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::domain::summary::SummaryRef;

/// Stable identifier for a [`Meeting`].
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct MeetingId(Uuid);

impl MeetingId {
    /// Generates a new, random meeting id.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for MeetingId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for MeetingId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for MeetingId {
    type Err = uuid::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Uuid::from_str(s).map(Self)
    }
}

/// A recorded meeting: audio, transcript, and any generated summaries.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Meeting {
    pub id: MeetingId,
    pub title: String,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub duration_sec: f32,
    pub audio_path: Option<PathBuf>,
    pub transcript: Option<myna_stt::Transcript>,
    pub summaries: Vec<SummaryRef>,
    #[serde(default)]
    pub archived: bool,
}

impl Meeting {
    /// Creates a new, empty meeting with a fresh id and the current time.
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            id: MeetingId::new(),
            title: title.into(),
            created_at: OffsetDateTime::now_utc(),
            duration_sec: 0.0,
            audio_path: None,
            transcript: None,
            summaries: Vec::new(),
            archived: false,
        }
    }

    /// Returns a copy of this meeting with `transcript` replaced.
    pub fn with_transcript(&self, transcript: myna_stt::Transcript) -> Self {
        Self {
            transcript: Some(transcript),
            ..self.clone()
        }
    }

    /// Returns a copy of this meeting with `summary` upserted into its
    /// summary list: an existing entry with the same `(template, language)`
    /// pair is replaced, otherwise `summary` is appended. Every other
    /// summary is left untouched.
    pub fn with_summary(&self, summary: SummaryRef) -> Self {
        let mut summaries: Vec<SummaryRef> = self
            .summaries
            .iter()
            .filter(|existing| {
                !(existing.template == summary.template && existing.language == summary.language)
            })
            .cloned()
            .collect();
        summaries.push(summary);
        Self {
            summaries,
            ..self.clone()
        }
    }

    /// Returns a copy of this meeting with `duration_sec` replaced.
    pub fn with_duration(&self, duration_sec: f32) -> Self {
        Self {
            duration_sec,
            ..self.clone()
        }
    }

    /// Returns a copy of this meeting with `title` replaced.
    pub fn with_title(&self, title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            ..self.clone()
        }
    }

    /// Returns a copy of this meeting with `audio_path` replaced.
    pub fn with_audio_path(&self, audio_path: PathBuf) -> Self {
        Self {
            audio_path: Some(audio_path),
            ..self.clone()
        }
    }

    /// Returns a copy of this meeting with `archived` replaced.
    pub fn with_archived(&self, archived: bool) -> Self {
        Self {
            archived,
            ..self.clone()
        }
    }
}
