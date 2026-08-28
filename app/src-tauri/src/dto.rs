//! Serde DTOs that cross the Tauri IPC boundary.
//!
//! Every shape here is `#[serde(rename_all = "camelCase")]` so the Angular
//! UI never has to translate field names, and every timestamp is rendered
//! as an RFC 3339 string rather than a native `OffsetDateTime`.

use serde::Serialize;
use time::OffsetDateTime;

use myna_audio::{SystemAudioSource, SystemAudioStatus};
use myna_stt::{Transcript, TranscriptSegment};

use crate::domain::{Meeting, Summary, SummaryRef};

/// [`SystemAudioSource`], IPC-facing: a pickable system-audio capture
/// source — either the synthetic all-output source or one running
/// application — surfaced both by `list_audio_sources` and, as the
/// *effective* source actually captured, on [`crate::events::RecordingStatePayload`].
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioSourceDto {
    pub id: String,
    pub name: String,
}

impl From<SystemAudioSource> for AudioSourceDto {
    fn from(source: SystemAudioSource) -> Self {
        Self {
            id: source.id,
            name: source.name,
        }
    }
}

/// [`SystemAudioStatus`], IPC-facing: same `kind`-tagged shape, but with
/// `camelCase` field names within each variant so the Angular UI never has
/// to translate.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SystemAudioStatusDto {
    Available,
    #[serde(rename_all = "camelCase")]
    PermissionDenied {
        restart_required: bool,
    },
    Unavailable {
        reason: String,
    },
    /// Mirrors [`SystemAudioStatus::Unknown`]: permission state genuinely
    /// cannot be determined without attempting a capture. Full UI/command
    /// surfacing of this variant is a later phase; it is included here only
    /// so this `From` conversion (and therefore the workspace build) stays
    /// exhaustive and correct as new `SystemAudioStatus` variants land.
    Unknown,
}

impl From<SystemAudioStatus> for SystemAudioStatusDto {
    fn from(status: SystemAudioStatus) -> Self {
        match status {
            SystemAudioStatus::Available => Self::Available,
            SystemAudioStatus::PermissionDenied { restart_required } => {
                Self::PermissionDenied { restart_required }
            }
            SystemAudioStatus::Unavailable { reason } => Self::Unavailable { reason },
            SystemAudioStatus::Unknown => Self::Unknown,
        }
    }
}

/// A single transcript segment, IPC-facing.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegmentDto {
    pub start_sec: f32,
    pub end_sec: f32,
    pub text: String,
}

impl From<TranscriptSegment> for TranscriptSegmentDto {
    fn from(segment: TranscriptSegment) -> Self {
        Self {
            start_sec: segment.start_sec,
            end_sec: segment.end_sec,
            text: segment.text,
        }
    }
}

/// A full transcript, IPC-facing.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptDto {
    pub segments: Vec<TranscriptSegmentDto>,
}

impl From<Transcript> for TranscriptDto {
    fn from(transcript: Transcript) -> Self {
        Self {
            segments: transcript.segments.into_iter().map(Into::into).collect(),
        }
    }
}

/// A language available for generated summary output, IPC-facing.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SummaryLanguageDto {
    pub code: String,
    pub label: String,
}

/// Pointer to a generated summary, IPC-facing.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SummaryRefDto {
    pub template: String,
    pub created_at: String,
    pub path: String,
    pub language: String,
}

impl From<SummaryRef> for SummaryRefDto {
    fn from(summary_ref: SummaryRef) -> Self {
        Self {
            template: summary_ref.template,
            created_at: rfc3339(summary_ref.created_at),
            path: summary_ref.path.to_string_lossy().into_owned(),
            language: summary_ref.language,
        }
    }
}

/// A generated [`Summary`]'s content, IPC-facing.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SummaryDto {
    pub template: String,
    pub markdown: String,
    pub created_at: String,
    pub language: String,
}

impl From<Summary> for SummaryDto {
    fn from(summary: Summary) -> Self {
        Self {
            template: summary.template,
            markdown: summary.markdown,
            created_at: rfc3339(summary.created_at),
            language: summary.language,
        }
    }
}

/// A [`Meeting`], IPC-facing.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MeetingDto {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub duration_sec: f32,
    pub audio_path: Option<String>,
    pub transcript: Option<TranscriptDto>,
    pub summaries: Vec<SummaryRefDto>,
}

impl From<Meeting> for MeetingDto {
    fn from(meeting: Meeting) -> Self {
        Self {
            id: meeting.id.to_string(),
            title: meeting.title,
            created_at: rfc3339(meeting.created_at),
            duration_sec: meeting.duration_sec,
            audio_path: meeting
                .audio_path
                .map(|path| path.to_string_lossy().into_owned()),
            transcript: meeting.transcript.map(TranscriptDto::from),
            summaries: meeting.summaries.into_iter().map(Into::into).collect(),
        }
    }
}

/// Formats `at` as an RFC 3339 string, falling back to its `Display` form
/// in the practically-impossible case formatting fails.
fn rfc3339(at: OffsetDateTime) -> String {
    at.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| at.to_string())
}
