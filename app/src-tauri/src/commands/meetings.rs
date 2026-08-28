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

use crate::domain::MeetingId;
use crate::dto::{MeetingDto, TranscriptDto};
use crate::error::AppError;
use crate::state::AppState;
use crate::store::MeetingStore;

/// Maximum length, in Unicode scalar values, a meeting title may have after
/// renaming. Keeps the sidebar meeting list legible.
pub const MAX_TITLE_LENGTH: usize = 200;

/// Lists every persisted meeting, newest first.
#[tauri::command]
pub async fn list_meetings(app: AppHandle) -> Result<Vec<MeetingDto>, AppError> {
    let store = app.state::<AppState>().store.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<MeetingDto>, AppError> {
        Ok(store.list()?.into_iter().map(MeetingDto::from).collect())
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
    tauri::async_runtime::spawn_blocking(move || Ok(MeetingDto::from(store.get(meeting_id)?)))
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
    Ok(MeetingDto::from(renamed))
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
