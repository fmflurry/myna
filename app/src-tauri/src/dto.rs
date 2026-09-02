//! Serde DTOs that cross the Tauri IPC boundary.
//!
//! Every shape here is `#[serde(rename_all = "camelCase")]` so the Angular
//! UI never has to translate field names, and every timestamp is rendered
//! as an RFC 3339 string rather than a native `OffsetDateTime`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use time::OffsetDateTime;

use myna_audio::{SystemAudioSource, SystemAudioStatus};
use myna_stt::{Speaker, Transcript, TranscriptSegment};

use crate::domain::{Folder, Meeting, Summary, SummaryRef};

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
    /// The flat stored speaker label (e.g. `"me"`, `"others"`,
    /// `"others:2"`, `"unknown"`) — see [`myna_stt::Speaker`]. Any code that
    /// parses this back from the UI must route it through
    /// [`myna_stt::Speaker::parse`] so a malformed label degrades to
    /// `"unknown"` rather than erroring.
    pub speaker: String,
}

impl From<TranscriptSegment> for TranscriptSegmentDto {
    fn from(segment: TranscriptSegment) -> Self {
        Self {
            start_sec: segment.start_sec,
            end_sec: segment.end_sec,
            speaker: segment.speaker.as_str().to_string(),
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

/// A transcript segment passed FROM the UI as an invoke argument — the
/// inbound counterpart to [`TranscriptSegmentDto`], consumed by
/// `restore_transcript_segments`. Unlike the outbound DTO, `speaker_pinned`
/// is REQUIRED here: the backend must know the explicit pin state of every
/// restored segment and cannot default a value the user never sent. A
/// missing or malformed `speaker` degrades to [`Speaker::unknown`] via
/// [`Speaker::parse`] — the codebase's documented data-loss gate.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegmentInput {
    pub start_sec: f32,
    pub end_sec: f32,
    pub text: String,
    #[serde(default)]
    pub speaker: Option<String>,
    pub speaker_pinned: bool,
}

impl From<TranscriptSegmentInput> for TranscriptSegment {
    fn from(input: TranscriptSegmentInput) -> Self {
        Self {
            start_sec: input.start_sec,
            end_sec: input.end_sec,
            text: input.text,
            speaker: input
                .speaker
                .map(|label| Speaker::parse(&label))
                .unwrap_or_else(Speaker::unknown),
            speaker_pinned: input.speaker_pinned,
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
    /// Whether the transcript this summary was generated from has since
    /// been replaced (e.g. by a re-transcribe). The markdown at `path` is
    /// still readable — this only flags that it may no longer reflect the
    /// current transcript.
    pub stale: bool,
}

impl From<SummaryRef> for SummaryRefDto {
    fn from(summary_ref: SummaryRef) -> Self {
        Self {
            template: summary_ref.template,
            created_at: rfc3339(summary_ref.created_at),
            path: summary_ref.path.to_string_lossy().into_owned(),
            language: summary_ref.language,
            stale: summary_ref.stale,
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
    pub archived: bool,
    /// Count of audio chunks silently dropped during recording (see
    /// `crate::session::DecodeChannel`). Non-zero means the transcript may
    /// be missing audio even though the recording itself is intact — the
    /// signal the UI uses to proactively offer a re-transcribe.
    pub dropped_audio_chunks: u32,
    /// Whether this meeting has recorded/imported audio on disk. Derived
    /// from the filesystem (`crate::ingest::has_audio`), not from
    /// `meeting.audio_path` — see that function's docs for why. Defaults to
    /// `false` on the plain [`From<Meeting>`] impl below; callers that know
    /// the meeting's on-disk audio state should build via
    /// [`MeetingDto::from_meeting`] instead.
    pub has_audio: bool,
    /// Whether this meeting has a captured system-audio STT track
    /// (`track-system.wav`) on disk. Derived from the filesystem
    /// (`crate::ingest::has_audio`, applied to
    /// `crate::store::MeetingStore::system_track_path`) exactly the way
    /// `has_audio` is — same computation point, same default-`false`
    /// fallback on the plain [`From<Meeting>`] impl below. Gates the
    /// "Detect speakers" action in the UI: a mic-only recording (or a
    /// legacy/imported meeting with no track separation) genuinely has
    /// nothing for diarization to analyze. Callers that know the meeting's
    /// on-disk track state should build via [`MeetingDto::from_meeting`]
    /// instead.
    pub has_system_track: bool,
    /// The folder this meeting is filed under, if any, as its string id.
    /// Always serialized (key-or-null), never omitted, so the UI can rely
    /// on the key's presence.
    pub folder_id: Option<String>,
    /// Display names keyed by flat speaker label (e.g. `"others:1"` ->
    /// `"Jean"`) — see [`Meeting::speaker_names`]. Always serialized
    /// (empty map when unnamed), so the speakers panel can render the
    /// name registry without a second round-trip.
    pub speaker_names: BTreeMap<String, String>,
}

impl MeetingDto {
    /// Builds a full DTO including the filesystem-derived `has_audio` and
    /// `has_system_track` flags.
    pub fn from_meeting(meeting: Meeting, has_audio: bool, has_system_track: bool) -> Self {
        Self {
            has_audio,
            has_system_track,
            ..Self::from(meeting)
        }
    }
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
            archived: meeting.archived,
            dropped_audio_chunks: meeting.dropped_audio_chunks,
            has_audio: false,
            has_system_track: false,
            folder_id: meeting.folder_id.map(|id| id.to_string()),
            speaker_names: meeting.speaker_names,
        }
    }
}

/// A [`Folder`], IPC-facing.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FolderDto {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub position: u32,
}

impl From<Folder> for FolderDto {
    fn from(folder: Folder) -> Self {
        Self {
            id: folder.id.to_string(),
            name: folder.name,
            created_at: rfc3339(folder.created_at),
            position: folder.position,
        }
    }
}

/// Outcome tag for [`UpdateCheckDto`]. `up-to-date` covers both "checked,
/// nothing newer" and "the manifest has no matching platform key for this
/// machine" — the latter must never read as an error to the user (see
/// `commands::updates::map_check_result`).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateCheckStatus {
    Available,
    UpToDate,
    Skipped,
    Failed,
}

/// Why a `check_for_update` call was skipped without ever reaching the
/// network — populated only when [`UpdateCheckDto::status`] is
/// [`UpdateCheckStatus::Skipped`].
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateSkipReason {
    NoConsent,
    Throttled,
    Recording,
}

/// Result of a `check_for_update` call, IPC-facing.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckDto {
    pub status: UpdateCheckStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<UpdateSkipReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Formats `at` as an RFC 3339 string, falling back to its `Display` form
/// in the practically-impossible case formatting fails.
fn rfc3339(at: OffsetDateTime) -> String {
    at.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| at.to_string())
}
