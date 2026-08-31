//! Event names and payloads emitted from the Rust core to the webview.
//!
//! Every payload is `Serialize + Clone` and rendered with `camelCase` field
//! names so the Angular UI can consume them without a translation layer.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use myna_audio::{CaptureSource, SystemAudioSource};
use myna_stt::TranscriptSegment;

use crate::domain::MeetingId;
use crate::dto::AudioSourceDto;
use crate::session::RecordingState;

/// Emitted whenever the recording state machine transitions.
pub const RECORDING_STATE: &str = "recording://state";
/// Emitted periodically while recording, carrying the current input level.
pub const RECORDING_LEVEL: &str = "recording://level";
/// Emitted with a live, not-yet-final transcript hypothesis.
pub const TRANSCRIPT_PARTIAL: &str = "transcript://partial";
/// Emitted once a transcript segment is finalized.
pub const TRANSCRIPT_FINAL: &str = "transcript://final";
/// Emitted when a background operation fails outside the normal command
/// response (e.g. a recording that dies mid-capture).
pub const APP_ERROR: &str = "error://occurred";
/// Emitted with each generated token while a summarization streams.
pub const SUMMARY_TOKEN: &str = "summary://token";
/// Emitted once a summarization completes successfully.
pub const SUMMARY_DONE: &str = "summary://done";

/// Payload for [`RECORDING_STATE`].
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatePayload {
    pub meeting_id: Option<String>,
    pub state: RecordingState,
    /// The effective capture source in use — after any fallback applied
    /// when the requested source needed system audio that wasn't
    /// available. See [`crate::session::resolve_capture_source`].
    pub source: CaptureSource,
    /// The effective system-audio source in use, when `source` is `System`
    /// or `Mixed` — after any fallback to all-output applied when the
    /// requested source id could no longer be resolved. `None` while
    /// `source` is `Microphone`, or before the system-audio backend has
    /// resolved a source yet — in which case a follow-up event carrying the
    /// resolved source is emitted once it does (see
    /// [`crate::session::announce_resolved_system_source`]).
    ///
    /// Renamed on the wire: the Angular adapter
    /// (`tauri-recorder.adapter.ts`) reads `effectiveSystemSource` off this
    /// event — a plain camelCase rendering would emit `systemSource` and
    /// the UI would permanently read `null` even for a healthy mixed
    /// recording.
    #[serde(rename = "effectiveSystemSource")]
    pub system_source: Option<AudioSourceDto>,
}

/// Builds and emits a [`RECORDING_STATE`] event. Shared by
/// `start_recording`'s initial emission (which necessarily carries
/// `system_source: None` — the capture backend hasn't resolved a source yet)
/// and the session worker's follow-up emission once it has.
pub fn emit_recording_state(
    app: &AppHandle,
    meeting_id: Option<MeetingId>,
    state: RecordingState,
    source: CaptureSource,
    system_source: Option<SystemAudioSource>,
) {
    let payload = RecordingStatePayload {
        meeting_id: meeting_id.map(|id| id.to_string()),
        state,
        source,
        system_source: system_source.map(AudioSourceDto::from),
    };
    let _ = app.emit(RECORDING_STATE, payload);
}

/// Payload for [`RECORDING_LEVEL`].
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LevelPayload {
    pub rms: f32,
    pub dbfs: f32,
}

/// Payload for [`TRANSCRIPT_PARTIAL`].
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PartialPayload {
    pub meeting_id: String,
    pub text: String,
    /// The flat stored speaker label (see [`myna_stt::Speaker`]) so a live,
    /// still-forming caption can be attributed the same way a finalized
    /// segment is.
    pub speaker: String,
}

/// Payload for [`TRANSCRIPT_FINAL`].
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FinalPayload {
    pub meeting_id: String,
    pub segment: TranscriptSegment,
}

/// Payload for [`APP_ERROR`].
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
}

/// Payload for [`SUMMARY_TOKEN`].
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TokenPayload {
    pub meeting_id: String,
    pub template: String,
    pub token: String,
}

/// Payload for [`SUMMARY_DONE`].
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SummaryDonePayload {
    pub meeting_id: String,
    pub template: String,
    pub language: String,
    pub markdown: String,
}

/// Emitted periodically while an audio import or re-transcribe runs,
/// reporting which phase it's in and how far through the source audio it
/// has processed.
pub const IMPORT_PROGRESS: &str = "import://progress";

/// Phase an in-flight import or re-transcribe is currently in, carried by
/// [`ImportProgressPayload`].
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ImportPhase {
    Converting,
    Transcribing,
    Done,
}

/// Payload for [`IMPORT_PROGRESS`].
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgressPayload {
    pub meeting_id: String,
    pub phase: ImportPhase,
    pub processed_sec: f32,
    pub total_sec: f32,
}
