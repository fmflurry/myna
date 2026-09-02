//! Meeting export: writes a meeting's transcript and every persisted
//! summary to a user-chosen destination path.
//!
//! The Angular UI owns the native "save file" dialog — this command only
//! ever receives an already-chosen `dest` path and writes to it.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use myna_stt::{Speaker, SpeakerRole, TranscriptSegment};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::domain::{Meeting, MeetingId, Summary};
use crate::error::AppError;
use crate::paths;
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
    let home = paths::home_dir_for_export().map_err(|err| AppError::Path(err.to_string()))?;
    export_meeting_confined(store, id, format, dest, &home)
}

/// Core of [`export_meeting_blocking`], parameterized on the confinement
/// root (`$HOME` in production, via [`export_meeting_blocking`]) rather than
/// resolving it internally, so integration tests can exercise real
/// rendering against an isolated `tempfile::tempdir()` destination without
/// writing into the real user home directory -- the same
/// resolve-the-real-thing-at-the-edge, parameterize-the-core pattern
/// `paths::resolve_models_root` uses.
pub fn export_meeting_confined(
    store: &dyn MeetingStore,
    id: MeetingId,
    format: ExportFormat,
    dest: &PathBuf,
    allowed_root: &Path,
) -> Result<(), AppError> {
    validate_export_destination(dest, allowed_root)?;

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

/// Confines an export destination to somewhere under `home` (the user's
/// home directory), rejecting anything under `home/Library` (macOS's
/// app-support/cache tree, which a native save dialog rooted at the user's
/// home should never resolve into, but which is worth an explicit
/// belt-and-braces reject). This is defence-in-depth, not a live-exploit
/// mitigation: the CSP is `default-src 'self'` and there is no
/// HTML-injection sink in the UI that could smuggle an attacker-controlled
/// `dest` past the native save dialog the caller always uses.
///
/// `dest` frequently does not exist yet -- the user is about to create the
/// file -- so this canonicalizes `dest`'s *parent* directory rather than
/// `dest` itself. Both `home` and the resolved parent are canonicalized
/// before comparison so a symlinked home directory (or a symlinked
/// destination directory) can't be used to escape the confinement check;
/// a canonicalization failure on either side is a typed [`AppError::Path`],
/// never a panic.
///
/// Takes `home` as a parameter (rather than resolving it internally) so
/// every branch is unit-testable against a `tempfile::tempdir()` standing
/// in for `$HOME`, without mutating the real process environment (which
/// `std::env::set_var` requires `unsafe` for, and this workspace forbids
/// `unsafe_code` outright).
fn validate_export_destination(dest: &Path, home: &Path) -> Result<(), AppError> {
    let parent = dest.parent().ok_or_else(|| {
        AppError::Path(format!(
            "export destination has no parent directory: {}",
            dest.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "<unknown>".to_string())
        ))
    })?;
    let canonical_parent = parent.canonicalize().map_err(|err| {
        AppError::Path(format!(
            "failed to resolve the export destination's directory: {err}"
        ))
    })?;
    let canonical_home = home
        .canonicalize()
        .map_err(|err| AppError::Path(format!("failed to resolve the home directory: {err}")))?;

    if !canonical_parent.starts_with(&canonical_home) {
        return Err(AppError::Path(
            "export destination must be inside your home directory".to_string(),
        ));
    }

    let library = canonical_home.join("Library");
    if canonical_parent.starts_with(&library) {
        return Err(AppError::Path(
            "export destination cannot be inside your Library directory".to_string(),
        ));
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    // --- validate_export_destination: at-rest confinement (security
    // hardening) --------------------------------------------------------

    #[test]
    fn validate_export_destination_rejects_a_dest_outside_the_home_directory() {
        // Arrange: `home` and `dest` are two unrelated tempdirs, so `dest`'s
        // parent can never resolve under `home`. Confirmed this fails
        // against the pre-fix code, which had no confinement check at all
        // and would have happily written to any destination the caller
        // supplied.
        let home = tempfile::tempdir().expect("tempdir");
        let outside = tempfile::tempdir().expect("tempdir");
        let dest = outside.path().join("meeting-export.md");
        std::fs::write(&dest, b"placeholder").expect("seed dest so its parent exists");

        // Act
        let result = validate_export_destination(&dest, home.path());

        // Assert
        assert!(
            matches!(result, Err(AppError::Path(_))),
            "expected AppError::Path for a destination outside the home directory, got: {result:?}"
        );
    }

    #[test]
    fn validate_export_destination_rejects_a_dest_inside_library() {
        // Arrange: `dest`'s parent is `home/Library/Caches`, which must be
        // refused even though it is technically "inside home".
        let home = tempfile::tempdir().expect("tempdir");
        let library_caches = home.path().join("Library").join("Caches");
        std::fs::create_dir_all(&library_caches).expect("create Library/Caches fixture");
        let dest = library_caches.join("meeting-export.md");

        // Act
        let result = validate_export_destination(&dest, home.path());

        // Assert
        assert!(
            matches!(result, Err(AppError::Path(_))),
            "expected AppError::Path for a destination under ~/Library, got: {result:?}"
        );
    }

    #[test]
    fn validate_export_destination_accepts_a_dest_directly_under_home() {
        // Arrange: an ordinary save-dialog destination, e.g. ~/Downloads.
        let home = tempfile::tempdir().expect("tempdir");
        let downloads = home.path().join("Downloads");
        std::fs::create_dir_all(&downloads).expect("create Downloads fixture");
        let dest = downloads.join("meeting-export.md");

        // Act
        let result = validate_export_destination(&dest, home.path());

        // Assert
        assert!(
            result.is_ok(),
            "an ordinary destination under home must be accepted, got: {result:?}"
        );
    }
}
