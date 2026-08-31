//! Meeting listing, retrieval, deletion, renaming, and transcript-lookup
//! commands.
//!
//! Every command here is an `async fn` that hands its store call to
//! [`tauri::async_runtime::spawn_blocking`]. Each read/write is individually
//! fast today, but they are genuine filesystem I/O (`FsMeetingStore` parses
//! one or more JSON files per call) that scales with how many meetings a
//! user has recorded, and `delete_meeting` removes a meeting's audio file
//! too — none of that belongs on the main thread by default.

use tauri::{AppHandle, Manager};
use time::{Month, OffsetDateTime};

use crate::commands::recording::lock_session;
use crate::domain::MeetingId;
use crate::dto::{MeetingDto, TranscriptDto};
use crate::error::AppError;
use crate::ingest;
use crate::session::guard_not_recording;
use crate::state::AppState;
use crate::store::MeetingStore;

/// Maximum length, in Unicode scalar values, a meeting title may have after
/// renaming. Keeps the sidebar meeting list legible.
pub const MAX_TITLE_LENGTH: usize = 200;

/// Maximum length, in Unicode scalar values, a transcript segment's text may
/// have after editing via [`edit_transcript_segment`].
pub const MAX_SEGMENT_TEXT_LENGTH: usize = 2000;

/// Lists every persisted meeting, newest first.
#[tauri::command]
pub async fn list_meetings(app: AppHandle) -> Result<Vec<MeetingDto>, AppError> {
    let store = app.state::<AppState>().store.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<MeetingDto>, AppError> {
        Ok(store
            .list()?
            .into_iter()
            .map(|meeting| {
                let has_audio = ingest::has_audio(&store.audio_path(meeting.id));
                let has_system_track = ingest::has_audio(&store.system_track_path(meeting.id));
                MeetingDto::from_meeting(meeting, has_audio, has_system_track)
            })
            .collect())
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Store(
            "list_meetings worker thread panicked".to_string(),
        ))
    })
}

/// Loads a single meeting by id.
#[tauri::command]
pub async fn get_meeting(app: AppHandle, id: String) -> Result<MeetingDto, AppError> {
    let meeting_id = parse_meeting_id(&id)?;
    let store = app.state::<AppState>().store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let meeting = store.get(meeting_id)?;
        let has_audio = ingest::has_audio(&store.audio_path(meeting_id));
        let has_system_track = ingest::has_audio(&store.system_track_path(meeting_id));
        Ok(MeetingDto::from_meeting(
            meeting,
            has_audio,
            has_system_track,
        ))
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Store(
            "get_meeting worker thread panicked".to_string(),
        ))
    })
}

/// Deletes a meeting and all of its associated files.
#[tauri::command]
pub async fn delete_meeting(app: AppHandle, id: String) -> Result<(), AppError> {
    let meeting_id = parse_meeting_id(&id)?;
    let store = app.state::<AppState>().store.clone();
    tauri::async_runtime::spawn_blocking(move || store.delete(meeting_id))
        .await
        .unwrap_or_else(|_| {
            Err(AppError::Store(
                "delete_meeting worker thread panicked".to_string(),
            ))
        })
}

/// Returns a meeting's transcript, or `None` if it hasn't been transcribed
/// yet.
#[tauri::command]
pub async fn get_transcript(app: AppHandle, id: String) -> Result<Option<TranscriptDto>, AppError> {
    let meeting_id = parse_meeting_id(&id)?;
    let store = app.state::<AppState>().store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(store.get(meeting_id)?.transcript.map(TranscriptDto::from))
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Store(
            "get_transcript worker thread panicked".to_string(),
        ))
    })
}

/// Renames a meeting.
///
/// The proposed `title` is trimmed and capped at [`MAX_TITLE_LENGTH`]
/// Unicode scalar values via [`normalize_title`]. When the trimmed title is
/// empty, the meeting's existing title is left unchanged (and nothing is
/// persisted) rather than failing the call or writing a blank name. This
/// never touches on-disk paths: meetings are keyed by [`MeetingId`], so only
/// `meeting.json`'s `title` field changes.
#[tauri::command]
pub async fn rename_meeting(
    app: AppHandle,
    meeting_id: String,
    title: String,
) -> Result<MeetingDto, AppError> {
    let id = parse_meeting_id(&meeting_id)?;
    let store = app.state::<AppState>().store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        rename_meeting_blocking(store.as_ref(), id, &title)
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Store(
            "rename_meeting worker thread panicked".to_string(),
        ))
    })
}

fn rename_meeting_blocking(
    store: &dyn MeetingStore,
    id: MeetingId,
    title: &str,
) -> Result<MeetingDto, AppError> {
    let meeting = store.get(id)?;
    let renamed = match normalize_title(title) {
        Some(new_title) => {
            let updated = meeting.with_title(new_title);
            store.save(&updated)?;
            updated
        }
        None => meeting,
    };
    let has_audio = ingest::has_audio(&store.audio_path(id));
    let has_system_track = ingest::has_audio(&store.system_track_path(id));
    Ok(MeetingDto::from_meeting(
        renamed,
        has_audio,
        has_system_track,
    ))
}

/// Archives or unarchives a meeting.
///
/// Refuses with [`AppError::Busy`] when `meeting_id` is the meeting the
/// active recording session (if any) is currently recording into — see
/// [`guard_not_recording`]. Idempotent: when the meeting's `archived` flag
/// already matches `archived`, this returns the meeting unchanged without
/// writing to disk.
#[tauri::command]
pub async fn set_meeting_archived(
    app: AppHandle,
    meeting_id: String,
    archived: bool,
) -> Result<MeetingDto, AppError> {
    let id = parse_meeting_id(&meeting_id)?;
    tauri::async_runtime::spawn_blocking(move || set_meeting_archived_blocking(&app, id, archived))
        .await
        .unwrap_or_else(|_| {
            Err(AppError::Store(
                "set_meeting_archived worker thread panicked".to_string(),
            ))
        })
}

fn set_meeting_archived_blocking(
    app: &AppHandle,
    id: MeetingId,
    archived: bool,
) -> Result<MeetingDto, AppError> {
    let state = app.state::<AppState>();
    let active_meeting_id = lock_session(&state)?
        .as_ref()
        .map(|session| session.meeting_id);
    guard_not_recording(active_meeting_id, id)?;

    let meeting = state.store.get(id)?;
    let has_audio = ingest::has_audio(&state.store.audio_path(id));
    let has_system_track = ingest::has_audio(&state.store.system_track_path(id));
    if meeting.archived == archived {
        return Ok(MeetingDto::from_meeting(
            meeting,
            has_audio,
            has_system_track,
        ));
    }
    let updated = meeting.with_archived(archived);
    state.store.save(&updated)?;
    Ok(MeetingDto::from_meeting(
        updated,
        has_audio,
        has_system_track,
    ))
}

/// Edits the text of one transcript segment.
///
/// Refuses with [`AppError::Busy`] when `meeting_id` is the meeting the
/// active recording session (if any) is currently recording into — see
/// [`guard_not_recording`]. Idempotent: when the normalized `text` produces
/// no change (either it's whitespace-only, via [`normalize_segment_text`],
/// or it matches the segment's current text), this returns the meeting
/// unchanged without writing to disk.
#[tauri::command]
pub async fn edit_transcript_segment(
    app: AppHandle,
    meeting_id: String,
    segment_index: usize,
    text: String,
) -> Result<MeetingDto, AppError> {
    let id = parse_meeting_id(&meeting_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        edit_transcript_segment_blocking(&app, id, segment_index, &text)
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Store(
            "edit_transcript_segment worker thread panicked".to_string(),
        ))
    })
}

fn edit_transcript_segment_blocking(
    app: &AppHandle,
    id: MeetingId,
    segment_index: usize,
    text: &str,
) -> Result<MeetingDto, AppError> {
    let state = app.state::<AppState>();
    let active_meeting_id = lock_session(&state)?
        .as_ref()
        .map(|session| session.meeting_id);
    guard_not_recording(active_meeting_id, id)?;

    let meeting = state.store.get(id)?;
    let has_audio = ingest::has_audio(&state.store.audio_path(id));
    let has_system_track = ingest::has_audio(&state.store.system_track_path(id));
    let Some(transcript) = &meeting.transcript else {
        return Err(AppError::NotFound(format!("transcript for meeting {id}")));
    };
    let edited = apply_segment_edit(transcript, segment_index, text)?;
    if &edited == transcript {
        return Ok(MeetingDto::from_meeting(
            meeting,
            has_audio,
            has_system_track,
        ));
    }
    let updated = meeting.with_transcript(edited);
    state.store.save(&updated)?;
    Ok(MeetingDto::from_meeting(
        updated,
        has_audio,
        has_system_track,
    ))
}

/// Trims and length-caps a proposed meeting title.
///
/// Returns `None` when the trimmed title is empty — callers treat that as
/// "no change" rather than persisting a blank name. Otherwise returns the
/// trimmed title, capped at [`MAX_TITLE_LENGTH`] Unicode scalar values
/// (`chars()`, not bytes, so multi-byte titles such as `"Réunion
/// d'équipe"` are never split mid-character).
pub fn normalize_title(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(MAX_TITLE_LENGTH).collect())
}

/// Trims and length-caps a proposed transcript segment text.
///
/// Returns `None` when the trimmed text is empty — callers treat that as
/// "no change" rather than persisting a blank segment. Otherwise returns the
/// trimmed text, capped at [`MAX_SEGMENT_TEXT_LENGTH`] Unicode scalar values
/// (`chars()`, not bytes, so multi-byte text such as `"Réunion d'équipe"` is
/// never split mid-character). Mirrors [`normalize_title`].
pub fn normalize_segment_text(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(MAX_SEGMENT_TEXT_LENGTH).collect())
}

/// Returns a new [`myna_stt::Transcript`] with the segment at `index`'s text
/// replaced by the normalized form of `text` (see [`normalize_segment_text`]).
///
/// Pure: never touches `AppHandle` or the store, and never mutates
/// `transcript` in place. `start_sec`, `end_sec`, and the order of every
/// segment are copied verbatim. Yields [`AppError::NotFound`] when `index` is
/// out of range. When `normalize_segment_text(text)` is `None` (empty or
/// whitespace-only), returns a clone of `transcript` unchanged, mirroring
/// `rename_meeting`'s "no-op on blank input" behavior.
pub fn apply_segment_edit(
    transcript: &myna_stt::Transcript,
    index: usize,
    text: &str,
) -> Result<myna_stt::Transcript, AppError> {
    if index >= transcript.segments.len() {
        return Err(AppError::NotFound(format!("segment {index}")));
    }
    let Some(normalized) = normalize_segment_text(text) else {
        return Ok(transcript.clone());
    };
    let mut segments = transcript.segments.clone();
    segments[index] = myna_stt::TranscriptSegment {
        text: normalized,
        ..segments[index].clone()
    };
    Ok(myna_stt::Transcript { segments })
}

/// Returns a new [`myna_stt::Transcript`] with the segment at `index` removed.
///
/// Pure: never mutates `transcript` in place. Yields [`AppError::NotFound`]
/// when `index` is out of range or when the segment at `index` no longer has
/// `expected_text` (optimistic-concurrency guard against acting on stale
/// UI state), leaving `transcript` untouched in either case. Deleting the
/// only segment yields an empty `Transcript { segments: vec![] }`, not a
/// dropped/`None` transcript.
pub fn apply_segment_delete(
    transcript: &myna_stt::Transcript,
    index: usize,
    expected_text: &str,
) -> Result<myna_stt::Transcript, AppError> {
    if index >= transcript.segments.len() {
        return Err(AppError::NotFound(format!("segment {index}")));
    }
    if transcript.segments[index].text != expected_text {
        return Err(AppError::NotFound(format!("segment {index}")));
    }
    let mut segments = transcript.segments.clone();
    segments.remove(index);
    Ok(myna_stt::Transcript { segments })
}

/// Returns a new [`myna_stt::Transcript`] with the segment at `index` merged
/// into the segment immediately before it.
///
/// Pure: never mutates `transcript` in place. Yields [`AppError::NotFound`]
/// when: `index` is `0` (there is no previous segment), `index` is out of
/// range, the segment at `index` no longer has `expected_text`
/// (optimistic-concurrency guard), the two segments have different
/// [`myna_stt::Speaker`] labels (compared by value, not display name), or the
/// joined text would exceed [`MAX_SEGMENT_TEXT_LENGTH`] — rejected rather
/// than truncated, since silent truncation here would lose data the user
/// didn't ask to lose.
///
/// The merged segment spans `prev.start_sec` to
/// `prev.end_sec.max(cur.end_sec)` (so an overlapping pair can never yield an
/// end before its start), joins text with a single ASCII space after
/// trimming both sides, clones (never re-parses) the shared speaker label,
/// and ORs `speaker_pinned` from both sides.
pub fn apply_segment_merge_up(
    transcript: &myna_stt::Transcript,
    index: usize,
    expected_text: &str,
) -> Result<myna_stt::Transcript, AppError> {
    if index == 0 || index >= transcript.segments.len() {
        return Err(AppError::NotFound(format!("segment {index}")));
    }
    let cur = &transcript.segments[index];
    if cur.text != expected_text {
        return Err(AppError::NotFound(format!("segment {index}")));
    }
    let prev = &transcript.segments[index - 1];
    if prev.speaker != cur.speaker {
        return Err(AppError::NotFound(format!("segment {index}")));
    }
    let text = format!("{} {}", prev.text.trim(), cur.text.trim());
    if text.chars().count() > MAX_SEGMENT_TEXT_LENGTH {
        return Err(AppError::NotFound(format!("segment {index}")));
    }
    let merged = myna_stt::TranscriptSegment {
        start_sec: prev.start_sec,
        end_sec: prev.end_sec.max(cur.end_sec),
        text,
        speaker: prev.speaker.clone(),
        speaker_pinned: prev.speaker_pinned || cur.speaker_pinned,
    };
    let mut segments = transcript.segments.clone();
    segments.splice(index - 1..=index, [merged]);
    Ok(myna_stt::Transcript { segments })
}

/// Returns a new [`myna_stt::Transcript`] with `remove_count` segments
/// starting at `index` replaced by `segments` (`Vec::splice` semantics).
///
/// Pure: never mutates `transcript` in place. Undoes an
/// [`apply_segment_delete`] (`remove_count: 0`, one restored segment) or an
/// [`apply_segment_merge_up`] (`remove_count: 1`, two restored segments),
/// preserving each restored segment's `speaker_pinned` individually. Yields
/// [`AppError::NotFound`] when `index + remove_count` exceeds the transcript's
/// length, or when any restored segment's speaker label is not the
/// canonical output of [`myna_stt::Speaker::parse`] — this rejects rather
/// than silently degrading a malformed label to `unknown`, which is
/// otherwise this codebase's documented data-loss gate.
pub fn apply_segment_restore(
    transcript: &myna_stt::Transcript,
    index: usize,
    remove_count: usize,
    segments: &[myna_stt::TranscriptSegment],
) -> Result<myna_stt::Transcript, AppError> {
    if index + remove_count > transcript.segments.len() {
        return Err(AppError::NotFound(format!("segment {index}")));
    }
    for segment in segments {
        let label = segment.speaker.as_str();
        if myna_stt::Speaker::parse(label).as_str() != label {
            return Err(AppError::NotFound(format!("segment {index}")));
        }
    }
    let mut new_segments = transcript.segments.clone();
    new_segments.splice(index..index + remove_count, segments.iter().cloned());
    Ok(myna_stt::Transcript {
        segments: new_segments,
    })
}

/// Parses a meeting id from its string form, surfacing an invalid id as
/// [`AppError::NotFound`] rather than a parse error.
fn parse_meeting_id(id: &str) -> Result<MeetingId, AppError> {
    id.parse().map_err(|_| AppError::NotFound(id.to_string()))
}

/// Generates a display title for a meeting from its creation timestamp,
/// e.g. `"Meeting 27 Aug 17:57"`.
///
/// Used by [`resolve_new_title`] as the fallback when the caller-supplied
/// title is empty or whitespace-only, so a new meeting never renders as a
/// bare timestamp (`— 27 Aug, 17:57`) in the UI heading and sidebar.
pub fn default_title(created_at: OffsetDateTime) -> String {
    format!(
        "Meeting {} {} {:02}:{:02}",
        created_at.day(),
        month_abbreviation(created_at.month()),
        created_at.hour(),
        created_at.minute()
    )
}

/// Resolves the title to persist for a newly created meeting: the trimmed,
/// length-capped `proposed` title (via [`normalize_title`]), or a
/// timestamp-derived default (via [`default_title`]) when `proposed` is
/// empty or whitespace-only.
///
/// This is the fix for meetings being created with an empty title — unlike
/// [`normalize_title`] (used by `rename_meeting`, where an empty proposal
/// means "no change"), an empty proposal here always yields a non-empty
/// title, since a brand-new meeting has no existing title to fall back to.
pub fn resolve_new_title(proposed: &str, created_at: OffsetDateTime) -> String {
    normalize_title(proposed).unwrap_or_else(|| default_title(created_at))
}

/// Three-letter month abbreviation used by [`default_title`].
fn month_abbreviation(month: Month) -> &'static str {
    match month {
        Month::January => "Jan",
        Month::February => "Feb",
        Month::March => "Mar",
        Month::April => "Apr",
        Month::May => "May",
        Month::June => "Jun",
        Month::July => "Jul",
        Month::August => "Aug",
        Month::September => "Sep",
        Month::October => "Oct",
        Month::November => "Nov",
        Month::December => "Dec",
    }
}
