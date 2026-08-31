//! Manual meeting-ordering command: drag-and-drop reordering, refiling, and
//! archiving in a single Tauri round-trip.
//!
//! Mirrors the blocking-core / async-wrapper idiom in
//! `crate::commands::folders::set_meeting_folder`.

use std::cmp::Ordering;

use tauri::{AppHandle, Manager};

use crate::commands::recording::lock_session;
use crate::domain::{
    effective_position, resolve_placement, FolderId, Meeting, MeetingId, Placement, RANK_GAP,
};
use crate::dto::MeetingDto;
use crate::error::AppError;
use crate::ingest;
use crate::session::guard_not_recording;
use crate::state::AppState;
use crate::store::MeetingStore;

/// Resolves the effective position of an optional neighbour id. A `None`
/// id, or one that no longer names a meeting (a stale sidebar racing a
/// concurrent delete), resolves to `None` rather than erroring -- the drop
/// gesture must never hard-fail on a dangling neighbour.
fn neighbour_position(meetings: &dyn MeetingStore, id: Option<MeetingId>) -> Option<f64> {
    id.and_then(|id| meetings.get(id).ok())
        .map(|meeting| effective_position(&meeting))
}

/// Rewrites every member of the target container (matching `archived` and
/// `folder_id`, excluding the meeting being placed) to fresh, evenly spaced
/// positions, best-effort.
///
/// Ordering is the container's current effective-position order, except
/// `previous_id`/`next_id` (when both present) are forced adjacent in that
/// relative order -- preserving the caller's intended drop order even when
/// their prior effective positions were exactly tied (the case that
/// triggered the renormalize in the first place).
fn renormalize_container(
    meetings: &dyn MeetingStore,
    exclude: MeetingId,
    archived: bool,
    folder_id: Option<FolderId>,
    previous_id: Option<MeetingId>,
    next_id: Option<MeetingId>,
) -> Result<(), AppError> {
    let mut container: Vec<Meeting> = meetings
        .list()?
        .into_iter()
        .filter(|meeting| {
            meeting.id != exclude && meeting.archived == archived && meeting.folder_id == folder_id
        })
        .collect();

    container.sort_by(|a, b| {
        effective_position(a)
            .total_cmp(&effective_position(b))
            .then_with(|| {
                if Some(a.id) == previous_id && Some(b.id) == next_id {
                    Ordering::Less
                } else if Some(a.id) == next_id && Some(b.id) == previous_id {
                    Ordering::Greater
                } else {
                    b.created_at.cmp(&a.created_at)
                }
            })
            .then_with(|| a.id.to_string().cmp(&b.id.to_string()))
    });

    for (index, member) in container.into_iter().enumerate() {
        let renormalized = member.with_position(Some(index as f64 * RANK_GAP));
        meetings.save(&renormalized)?;
    }

    Ok(())
}

/// Resolves the drop placement for a meeting between `previous_id` and
/// `next_id`, renormalizing the target container and retrying exactly once
/// when the neighbours' positions leave no room. Fails with
/// [`AppError::Store`] when a single renormalize still cannot resolve the
/// conflict.
fn resolve_placement_with_retry(
    meetings: &dyn MeetingStore,
    id: MeetingId,
    archived: bool,
    folder_id: Option<FolderId>,
    previous_id: Option<MeetingId>,
    next_id: Option<MeetingId>,
) -> Result<Placement, AppError> {
    let placement = resolve_placement(
        neighbour_position(meetings, previous_id),
        neighbour_position(meetings, next_id),
    );
    if placement != Placement::Renormalize {
        return Ok(placement);
    }

    renormalize_container(meetings, id, archived, folder_id, previous_id, next_id)?;

    let retried = resolve_placement(
        neighbour_position(meetings, previous_id),
        neighbour_position(meetings, next_id),
    );
    if retried == Placement::Renormalize {
        return Err(AppError::Store(
            "unable to place meeting: position conflict persisted after renormalize".to_string(),
        ));
    }
    Ok(retried)
}

/// Sets a meeting's archived flag, folder, and manual ordering position in a
/// single call -- the drag-and-drop drop gesture's backend counterpart.
///
/// Refuses with [`AppError::Busy`] when `id` is the meeting the active
/// recording session (if any) is currently recording into -- see
/// [`guard_not_recording`], checked *before* anything else so a busy
/// recording session never triggers a renormalize write. Neighbour ids
/// (`previous_id`, `next_id`) that name no meeting resolve to `None` rather
/// than erroring -- see [`neighbour_position`]. Idempotent: when `archived`,
/// `folder_id`, and the resolved position all already match, this returns
/// the meeting unchanged without writing to disk.
pub fn set_meeting_placement_blocking(
    meetings: &dyn MeetingStore,
    id: MeetingId,
    folder_id: Option<FolderId>,
    archived: bool,
    previous_id: Option<MeetingId>,
    next_id: Option<MeetingId>,
    active: Option<MeetingId>,
) -> Result<Meeting, AppError> {
    guard_not_recording(active, id)?;

    let meeting = meetings.get(id)?;

    let placement =
        resolve_placement_with_retry(meetings, id, archived, folder_id, previous_id, next_id)?;

    let new_position = match placement {
        Placement::Set(value) => Some(value),
        Placement::Keep | Placement::Renormalize => meeting.position,
    };

    let updated = meeting
        .with_archived(archived)
        .with_folder(folder_id)
        .with_position(new_position);

    if updated == meeting {
        return Ok(meeting);
    }

    meetings.save(&updated)?;
    Ok(updated)
}

/// Sets a meeting's archived flag, folder, and manual ordering position in a
/// single call.
#[tauri::command]
pub async fn set_meeting_placement(
    app: AppHandle,
    meeting_id: String,
    folder_id: Option<String>,
    archived: bool,
    previous_id: Option<String>,
    next_id: Option<String>,
) -> Result<MeetingDto, AppError> {
    let id = parse_meeting_id(&meeting_id)?;
    let parsed_folder_id = match folder_id {
        Some(raw) => Some(parse_folder_id(&raw)?),
        None => None,
    };
    let parsed_previous_id = previous_id.and_then(|raw| raw.parse().ok());
    let parsed_next_id = next_id.and_then(|raw| raw.parse().ok());

    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let active_meeting_id = lock_session(&state)?
            .as_ref()
            .map(|session| session.meeting_id);
        let updated = set_meeting_placement_blocking(
            state.store.as_ref(),
            id,
            parsed_folder_id,
            archived,
            parsed_previous_id,
            parsed_next_id,
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
            "set_meeting_placement worker thread panicked".to_string(),
        ))
    })
}

/// Parses a folder id from its string form, surfacing an invalid id as
/// [`AppError::NotFound`] rather than a parse error. Local mirror of the
/// private `crate::commands::folders::parse_folder_id` idiom (that function
/// isn't `pub(crate)`, so it can't be reused directly here).
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
