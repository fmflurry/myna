//! Folder listing, creation, renaming, deletion, and meeting-assignment
//! commands.
//!
//! Every command here is an `async fn` that hands its store call to
//! [`tauri::async_runtime::spawn_blocking`], mirroring the idiom in
//! `crate::commands::meetings`.

use tauri::{AppHandle, Manager};

use crate::commands::recording::lock_session;
use crate::domain::{Folder, FolderId, Meeting, MeetingId};
use crate::dto::{FolderDto, MeetingDto};
use crate::error::AppError;
use crate::ingest;
use crate::session::guard_not_recording;
use crate::state::AppState;
use crate::store::{FolderStore, MeetingStore};

/// Maximum length, in Unicode scalar values, a folder name may have.
/// Mirrors `crate::commands::meetings::MAX_TITLE_LENGTH`.
pub const MAX_FOLDER_NAME_LENGTH: usize = 100;

/// Trims and length-caps a proposed folder name.
///
/// Returns `None` when the trimmed name is empty. Otherwise returns the
/// trimmed name, capped at [`MAX_FOLDER_NAME_LENGTH`] Unicode scalar values
/// (`chars()`, not bytes, so multi-byte names are never split
/// mid-character). Mirrors `crate::commands::meetings::normalize_title`.
pub fn normalize_folder_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(MAX_FOLDER_NAME_LENGTH).collect())
}

/// Creates a new folder named `name`.
///
/// Fails with [`AppError::Store`] when `name` is blank (after trimming) —
/// unlike renaming, there is no existing folder to fall back to, so a blank
/// create request is rejected rather than silently accepted.
pub fn create_folder_blocking(folders: &dyn FolderStore, name: &str) -> Result<Folder, AppError> {
    let normalized = normalize_folder_name(name)
        .ok_or_else(|| AppError::Store("folder name must not be blank".to_string()))?;
    folders.create(&normalized)
}

/// Renames the folder with id `id` to `name`.
///
/// When the trimmed `name` is empty, this is a no-op: the folder's existing
/// name is left unchanged (and nothing is persisted) rather than failing the
/// call or writing a blank name, mirroring
/// `crate::commands::meetings::rename_meeting`. Yields [`AppError::NotFound`]
/// when no folder with `id` exists.
pub fn rename_folder_blocking(
    folders: &dyn FolderStore,
    id: FolderId,
    name: &str,
) -> Result<Folder, AppError> {
    let existing = folders
        .list()?
        .into_iter()
        .find(|folder| folder.id == id)
        .ok_or_else(|| AppError::NotFound(id.to_string()))?;

    match normalize_folder_name(name) {
        Some(normalized) => {
            let updated = existing.with_name(&normalized);
            folders.save(&updated)?;
            Ok(updated)
        }
        None => Ok(existing),
    }
}

/// Deletes the folder with id `id`, then reassigns every meeting filed under
/// it (`folder_id == Some(id)`) back to unassigned (`folder_id = None`),
/// except the meeting equal to `active` (if any) — its dangling `folder_id`
/// is legal and simply reads as Uncategorized in the UI until it is next
/// saved.
pub fn delete_folder_blocking(
    folders: &dyn FolderStore,
    meetings: &dyn MeetingStore,
    id: FolderId,
    active: Option<MeetingId>,
) -> Result<(), AppError> {
    folders.delete(id)?;

    for meeting in meetings.list()? {
        if meeting.folder_id != Some(id) {
            continue;
        }
        if Some(meeting.id) == active {
            continue;
        }
        let updated = meeting.with_folder(None);
        meetings.save(&updated)?;
    }

    Ok(())
}

/// Assigns (or unassigns, when `folder_id` is `None`) the meeting `id` to
/// `folder_id`.
///
/// Refuses with [`AppError::Busy`] when `id` is the meeting the active
/// recording session (if any) is currently recording into — see
/// [`guard_not_recording`]. Idempotent: when the meeting's `folder_id`
/// already matches `folder_id`, this returns the meeting unchanged without
/// writing to disk. Never validates `folder_id` against the folder store —
/// see `crate::domain::meeting::Meeting::folder_id`'s docs for why.
pub fn set_meeting_folder_blocking(
    meetings: &dyn MeetingStore,
    id: MeetingId,
    folder_id: Option<FolderId>,
    active: Option<MeetingId>,
) -> Result<Meeting, AppError> {
    guard_not_recording(active, id)?;

    let meeting = meetings.get(id)?;
    if meeting.folder_id == folder_id {
        return Ok(meeting);
    }
    let updated = meeting.with_folder(folder_id);
    meetings.save(&updated)?;
    Ok(updated)
}

/// Lists every persisted folder, sorted by `(position, created_at)`.
#[tauri::command]
pub async fn list_folders(app: AppHandle) -> Result<Vec<FolderDto>, AppError> {
    let folders = app.state::<AppState>().folders.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<FolderDto>, AppError> {
        Ok(folders.list()?.into_iter().map(FolderDto::from).collect())
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Store(
            "list_folders worker thread panicked".to_string(),
        ))
    })
}

/// Creates a new folder named `name`.
#[tauri::command]
pub async fn create_folder(app: AppHandle, name: String) -> Result<FolderDto, AppError> {
    let folders = app.state::<AppState>().folders.clone();
    tauri::async_runtime::spawn_blocking(move || {
        create_folder_blocking(folders.as_ref(), &name).map(FolderDto::from)
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Store(
            "create_folder worker thread panicked".to_string(),
        ))
    })
}

/// Renames the folder `folder_id` to `name`.
#[tauri::command]
pub async fn rename_folder(
    app: AppHandle,
    folder_id: String,
    name: String,
) -> Result<FolderDto, AppError> {
    let id = parse_folder_id(&folder_id)?;
    let folders = app.state::<AppState>().folders.clone();
    tauri::async_runtime::spawn_blocking(move || {
        rename_folder_blocking(folders.as_ref(), id, &name).map(FolderDto::from)
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Store(
            "rename_folder worker thread panicked".to_string(),
        ))
    })
}

/// Deletes the folder `folder_id`, reassigning any meetings filed under it
/// back to unassigned.
#[tauri::command]
pub async fn delete_folder(app: AppHandle, folder_id: String) -> Result<(), AppError> {
    let id = parse_folder_id(&folder_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let active_meeting_id = lock_session(&state)?
            .as_ref()
            .map(|session| session.meeting_id);
        delete_folder_blocking(
            state.folders.as_ref(),
            state.store.as_ref(),
            id,
            active_meeting_id,
        )
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Store(
            "delete_folder worker thread panicked".to_string(),
        ))
    })
}

/// Assigns (or unassigns) the meeting `meeting_id` to `folder_id`.
#[tauri::command]
pub async fn set_meeting_folder(
    app: AppHandle,
    meeting_id: String,
    folder_id: Option<String>,
) -> Result<MeetingDto, AppError> {
    let id = parse_meeting_id(&meeting_id)?;
    let parsed_folder_id = match folder_id {
        Some(raw) => Some(parse_folder_id(&raw)?),
        None => None,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let active_meeting_id = lock_session(&state)?
            .as_ref()
            .map(|session| session.meeting_id);
        let updated = set_meeting_folder_blocking(
            state.store.as_ref(),
            id,
            parsed_folder_id,
            active_meeting_id,
        )?;
        let has_audio = ingest::has_audio(&state.store.audio_path(id));
        let has_system_track = ingest::has_audio(&state.store.system_track_path(id));
        Ok(MeetingDto::from_meeting(
            updated,
            has_audio,
            has_system_track,
        ))
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Store(
            "set_meeting_folder worker thread panicked".to_string(),
        ))
    })
}

/// Parses a folder id from its string form, surfacing an invalid id as
/// [`AppError::NotFound`] rather than a parse error. Mirrors
/// `crate::commands::meetings::parse_meeting_id`.
fn parse_folder_id(id: &str) -> Result<FolderId, AppError> {
    id.parse().map_err(|_| AppError::NotFound(id.to_string()))
}

/// Parses a meeting id from its string form, surfacing an invalid id as
/// [`AppError::NotFound`] rather than a parse error. Local mirror of the
/// private `crate::commands::meetings::parse_meeting_id` idiom (that
/// function isn't `pub(crate)`, so it can't be reused directly here).
fn parse_meeting_id(id: &str) -> Result<MeetingId, AppError> {
    id.parse().map_err(|_| AppError::NotFound(id.to_string()))
}
