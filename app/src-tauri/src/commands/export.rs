//! Meeting export: writes a meeting's transcript and every persisted
//! summary to a user-chosen destination path.
//!
//! The Angular UI owns the native "save file" dialog — this command only
//! ever receives an already-chosen `dest` path and writes to it.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use myna_stt::{Speaker, SpeakerRole, TranscriptSegment};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::domain::{Meeting, MeetingId, Summary};
use crate::error::AppError;
use crate::state::AppState;
use crate::store::MeetingStore;

/// Export output format requested by the UI.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Markdown,
    Text,
    Json,
}

/// Writes `meeting_id`'s transcript and every persisted summary to `dest`,
/// formatted per `format`.
///
/// `async fn`: reads every persisted summary plus the transcript, then
/// writes the rendered document to `dest` — filesystem I/O whose size scales
/// with the meeting, so it runs inside
/// [`tauri::async_runtime::spawn_blocking`] rather than the main thread.
#[tauri::command]
pub async fn export_meeting(
    app: AppHandle,
    meeting_id: String,
    format: ExportFormat,
    dest: PathBuf,
) -> Result<(), AppError> {
    let id = parse_meeting_id(&meeting_id)?;
    let store = app.state::<AppState>().store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        export_meeting_blocking(store.as_ref(), id, format, &dest)
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Store(
            "export_meeting worker thread panicked".to_string(),
        ))
    })
}

pub fn export_meeting_blocking(
    store: &dyn MeetingStore,
    id: MeetingId,
    format: ExportFormat,
    dest: &PathBuf,
) -> Result<(), AppError> {
    let meeting = store.get(id)?;
    let summaries = load_summaries(store, id, &meeting)?;

    let contents = match format {
        ExportFormat::Markdown => Ok(render_markdown(&meeting, &summaries)),
        ExportFormat::Text => Ok(render_text(&meeting, &summaries)),
        ExportFormat::Json => render_json(&meeting, &summaries),
    }?;

    fs::write(dest, contents)?;
    Ok(())
}

/// Loads every summary referenced by `meeting`'s [`SummaryRef`](crate::domain::SummaryRef) list.
fn load_summaries(
    store: &dyn MeetingStore,
    id: MeetingId,
    meeting: &Meeting,
) -> Result<Vec<Summary>, AppError> {
    meeting
        .summaries
        .iter()
        .map(|summary_ref| store.read_summary(id, &summary_ref.template, &summary_ref.language))
        .collect()
}

/// Renders `meeting` and `summaries` as a Markdown document.
fn render_markdown(meeting: &Meeting, summaries: &[Summary]) -> String {
    let mut out = format!("# {}\n\n## Transcript\n\n", meeting.title);

    if let Some(transcript) = &meeting.transcript {
        for (speaker, run) in group_by_speaker(&transcript.segments) {
            if let Some(name) = speaker_display_name(&speaker, &meeting.speaker_names) {
                out.push_str(&format!("**{name}:**\n\n"));
            }
            for segment in run {
                out.push_str(&format!(
                    "- [{:.1}s - {:.1}s] {}\n",
                    segment.start_sec, segment.end_sec, segment.text
                ));
            }
        }
    }
    out.push('\n');

    for summary in summaries {
        out.push_str(&format!(
            "## Summary: {}\n\n{}\n\n",
            summary.template, summary.markdown
        ));
    }

    out
}

/// Renders `meeting` and `summaries` as plain text.
fn render_text(meeting: &Meeting, summaries: &[Summary]) -> String {
    let mut out = format!("{}\n\nTranscript:\n", meeting.title);

    if let Some(transcript) = &meeting.transcript {
        for (speaker, run) in group_by_speaker(&transcript.segments) {
            if let Some(name) = speaker_display_name(&speaker, &meeting.speaker_names) {
                out.push_str(&format!("{name}:\n"));
            }
            for segment in run {
                out.push_str(&segment.text);
                out.push('\n');
            }
        }
    }
    out.push('\n');

    for summary in summaries {
        out.push_str(&format!(
            "Summary ({}):\n{}\n\n",
            summary.template, summary.markdown
        ));
    }

    out
}

/// Groups `segments` into runs of consecutive segments sharing the same
/// [`Speaker`] — the same grouping [`myna_stt::Transcript::attributed_text`]
/// uses — so a renderer emits one speaker header per run instead of one per
/// segment.
fn group_by_speaker(segments: &[TranscriptSegment]) -> Vec<(Speaker, Vec<&TranscriptSegment>)> {
    let mut groups: Vec<(Speaker, Vec<&TranscriptSegment>)> = Vec::new();
    for segment in segments {
        match groups.last_mut() {
            Some((speaker, run)) if *speaker == segment.speaker => run.push(segment),
            _ => groups.push((segment.speaker.clone(), vec![segment])),
        }
    }
    groups
}

/// The display name for a speaker block header, or `None` when the
/// speaker's role is [`SpeakerRole::Unknown`] — in which case the caller
/// must emit no header at all, which is what keeps a legacy (pre-speaker)
/// meeting's export byte-identical to its pre-change output.
///
/// A label with an entry in `names` (keyed by its flat form, e.g.
/// `"others:1"`) renders under that user-assigned display name instead of
/// its role-derived label. Grouping by [`Speaker`] happens before this is
/// called (see [`group_by_speaker`]), so two distinct labels sharing a
/// display name still render as separate blocks — only the header text
/// changes here, never the grouping.
fn speaker_display_name(speaker: &Speaker, names: &BTreeMap<String, String>) -> Option<String> {
    if let Some(name) = names.get(speaker.as_str()) {
        return Some(name.clone());
    }
    match speaker.role() {
        SpeakerRole::Unknown => None,
        SpeakerRole::Me => Some("Me".to_string()),
        SpeakerRole::Others => Some(match speaker.sub_id() {
            Some(id) => format!("Others {id}"),
            None => "Others".to_string(),
        }),
    }
}

/// The shape written by [`ExportFormat::Json`]: the raw meeting plus its
/// resolved summary contents.
#[derive(Serialize)]
struct ExportJson<'a> {
    meeting: &'a Meeting,
    summaries: &'a [Summary],
}

/// Renders `meeting` and `summaries` as pretty-printed JSON.
fn render_json(meeting: &Meeting, summaries: &[Summary]) -> Result<String, AppError> {
    serde_json::to_string_pretty(&ExportJson { meeting, summaries })
        .map_err(|err| AppError::Store(err.to_string()))
}

/// Parses a meeting id from its string form, surfacing an invalid id as
/// [`AppError::NotFound`] rather than a parse error.
fn parse_meeting_id(id: &str) -> Result<MeetingId, AppError> {
    id.parse().map_err(|_| AppError::NotFound(id.to_string()))
}
