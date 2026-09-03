//! Recording lifecycle commands: start, stop, cancel, and query current
//! state.
//!
//! `start_recording`, `stop_recording`, and `cancel_recording` are
//! `async fn`s whose entire (synchronous) body runs inside a single
//! [`tauri::async_runtime::spawn_blocking`] closure — see each command's
//! doc comment. Running the *whole* body as one blocking closure, rather
//! than only the specific slow step, means [`AppState::session`]'s
//! `Mutex` is locked and released entirely within that closure, exactly as
//! it was when these were plain synchronous commands: the lock is never
//! held across an `.await`, and the busy-guard semantics
//! ([`guard_start`]/[`guard_stop`]) are unchanged under concurrency,
//! because the `Mutex` still fully serializes concurrent attempts — one
//! caller's closure runs the whole critical section (including the
//! multi-second STT model load or worker-thread join) before another's can
//! even evaluate its guard check.

use std::sync::MutexGuard;

use myna_audio::{CaptureSource, DeviceInfo};
use myna_stt::VadConfig;
use tauri::{AppHandle, Emitter, Manager, State};
use time::OffsetDateTime;

use crate::commands::meetings::resolve_new_title;
use crate::domain::MeetingId;
use crate::dto::{AudioSourceDto, MeetingDto, TranscriptDto};
use crate::error::AppError;
use crate::events::{emit_recording_state, ErrorPayload, RecordingStatePayload, APP_ERROR};
use crate::paths;
use crate::recovery;
use crate::session::{
    guard_start, guard_stop, resolve_capture_source, resolve_system_source_id, AudioPaths,
    CaptureSelection, RecordingSession, RecordingState,
};
use crate::session_manifest::{self, SessionManifest};
use crate::state::{AppState, StoppingGuard};
use crate::store::fs_store::FsMeetingStore;
use crate::store::MeetingStore;

/// Directory name (under the resolved models root) containing the Silero
/// VAD model artifact.
const VAD_MODEL_DIR_NAME: &str = "silero-vad";
/// File name of the Silero VAD model, within [`VAD_MODEL_DIR_NAME`].
const VAD_MODEL_FILE_NAME: &str = "silero_vad.onnx";

/// [`ErrorPayload`]'s `code` field, emitted by [`stop_recording_blocking`]
/// when the recording's [`crate::session::DecodeChannel`] dropped one or
/// more audio chunks — see [`emit_dropped_audio_warning`].
const DROPPED_AUDIO_CHUNKS_CODE: &str = "AUDIO_CHUNKS_DROPPED";
/// Plain-language [`ErrorPayload`] `message` for [`DROPPED_AUDIO_CHUNKS_CODE`].
const DROPPED_AUDIO_CHUNKS_MESSAGE: &str = "Some audio was not transcribed. The recording is \
     intact — re-transcribe from audio to recover the full transcript.";

/// Starts recording a new meeting titled `title` on `device` (the host's
/// default input device when `None`), from `source` (the microphone when
/// `None`). Fails with [`AppError::Busy`] if a recording is already in
/// progress.
///
/// When `title` is empty or whitespace-only, a timestamp-derived default is
/// used instead (see [`resolve_new_title`]), so a meeting is never created
/// with a blank title.
///
/// When `source` requests `System` or `Mixed` audio but system-audio
/// capture is not currently available, the recording falls back to the
/// microphone rather than failing outright — see
/// [`resolve_capture_source`].
///
/// `async fn`: lazily loading the STT model on first use is seconds-scale,
/// and device setup (`myna_audio::system_audio_status`,
/// `list_system_audio_sources`, `resolve_device`) round-trips to
/// `coreaudiod`. The whole body runs inside
/// [`tauri::async_runtime::spawn_blocking`] via [`start_recording_blocking`]
/// so none of that occupies the main thread.
#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    title: String,
    device: Option<String>,
    source: Option<CaptureSource>,
    system_source: Option<String>,
) -> Result<MeetingDto, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        start_recording_blocking(&app, title, device, source, system_source)
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Store(
            "start_recording worker thread panicked".to_string(),
        ))
    })
}

/// Synchronous body of [`start_recording`], run on a blocking-pool thread.
/// See the module doc comment for why the `Mutex` lock spanning this whole
/// function is safe under concurrency despite never being held across an
/// `.await`.
fn start_recording_blocking(
    app: &AppHandle,
    title: String,
    device: Option<String>,
    source: Option<CaptureSource>,
    system_source: Option<String>,
) -> Result<MeetingDto, AppError> {
    let state = app.state::<AppState>();
    let mut session_slot = lock_session(&state)?;
    guard_start(session_slot.is_some(), state.import_busy())?;

    let effective_title = resolve_new_title(&title, OffsetDateTime::now_utc());
    let meeting = state.store.create(&effective_title)?;
    let audio_paths = AudioPaths {
        playback: state.store.audio_path(meeting.id),
        mic: state.store.mic_track_path(meeting.id),
        system: state.store.system_track_path(meeting.id),
        journal_path: state.store.transcript_journal_path(meeting.id),
    };
    let effective_source = resolve_capture_source(source, myna_audio::system_audio_status());
    let device_info = match effective_source {
        CaptureSource::Microphone | CaptureSource::Mixed => Some(resolve_device(device)?),
        CaptureSource::System => None,
    };
    let available_system_sources = myna_audio::list_system_audio_sources();
    let effective_system_source_id =
        resolve_system_source_id(system_source, &available_system_sources);
    let engine = state.stt_engine(app)?;
    let vad_cfg = VadConfig {
        model_path: paths::models_root(app)
            .join(VAD_MODEL_DIR_NAME)
            .join(VAD_MODEL_FILE_NAME),
        ..VadConfig::default()
    };

    let selection = CaptureSelection {
        source: effective_source,
        device: device_info,
        system_source_id: effective_system_source_id.clone(),
    };
    let session = RecordingSession::start(
        app.clone(),
        meeting.id,
        selection,
        audio_paths,
        engine,
        &vad_cfg,
    )?;

    let session_source = session.source;
    let session_system_source = session.system_source();
    *session_slot = Some(session);

    // Durability manifest, written only AFTER the session started cleanly,
    // and carrying the EFFECTIVE source (post-fallback) — the recovery
    // invariant is "manifest exists == a recording is in progress" (ADR
    // 0011). A manifest write failure is logged, never fatal: the user's
    // live recording must not be aborted over recovery metadata.
    let manifest = SessionManifest::new(
        &meeting.id.to_string(),
        session_source,
        effective_system_source_id,
    );
    if let Err(err) =
        session_manifest::write_manifest(&state.store.session_manifest_path(meeting.id), &manifest)
    {
        eprintln!(
            "myna-app: failed to write session manifest for meeting {}: {err} — this \
             recording will not be recoverable after a crash",
            meeting.id
        );
    }
    // Note: this initial event carries `system_source: None` whenever the
    // capture worker hasn't resolved the system-audio source yet (the normal
    // case — the Core Audio attach takes longer than these few statements).
    // The worker emits a follow-up `recording://state` with the resolved
    // source once it has one; see
    // `crate::session::announce_resolved_system_source`.
    emit_recording_state(
        app,
        Some(meeting.id),
        RecordingState::Recording,
        session_source,
        session_system_source,
    );

    Ok(MeetingDto::from(meeting))
}

/// Stops the active recording, persists its transcript and duration, and
/// returns the updated meeting.
///
/// When the recording worker died mid-capture, the meeting is salvaged from
/// the on-disk journal + repaired WAVs rather than being lost — see
/// [`recover_after_failed_stop`].
///
/// `async fn`: [`RecordingSession::stop`] joins the capture and decode
/// worker threads and runs a final decode, which is easily seconds. The
/// whole body runs inside [`tauri::async_runtime::spawn_blocking`] via
/// [`stop_recording_blocking`] so that join never blocks the main thread.
#[tauri::command]
pub async fn stop_recording(app: AppHandle) -> Result<MeetingDto, AppError> {
    tauri::async_runtime::spawn_blocking(move || stop_recording_blocking(&app))
        .await
        .unwrap_or_else(|_| {
            Err(AppError::Store(
                "stop_recording worker thread panicked".to_string(),
            ))
        })
}

fn stop_recording_blocking(app: &AppHandle) -> Result<MeetingDto, AppError> {
    let state = app.state::<AppState>();
    // `take_session` marks the stop as in flight BEFORE the session leaves
    // the slot, so a webview reloading during the multi-second
    // final-decode join below sees `stopping` from `recording_state`,
    // never a false `idle` (MINOR-1). The guard clears the marker when
    // this function returns — after the save + artifact cleanup at the
    // tail, and after the salvage on the dead-worker path.
    let (session, _stopping) = take_session(&state)?;
    let meeting_id = session.meeting_id;
    let duration_sec = session.elapsed_sec();
    let source = session.source;
    let system_source = session.system_source();

    emit_recording_state(
        app,
        Some(meeting_id),
        RecordingState::Stopping,
        source,
        system_source.clone(),
    );
    let stop_result = session.stop();
    emit_recording_state(app, None, RecordingState::Idle, source, system_source);
    // The session (and its `Arc<SttEngine>`) is gone: restart the
    // engine's idle-TTL countdown from *now* so a follow-up recording
    // within [`crate::state::IDLE_MODEL_TTL`] reuses the warm engine, and
    // only a genuinely idle app releases its ~1 GB later. The salvage path
    // below also stops after `stop()`, so touching here covers both.
    state.touch_stt_last_used();

    let (transcript, dropped_chunks) = match stop_result {
        Ok(result) => result,
        // The worker died mid-recording. Never dead-end the user: salvage
        // the meeting from the durability artifacts instead of discarding
        // a whole recording over a decode failure.
        Err(err) => {
            return recover_after_failed_stop(app, &state, meeting_id, duration_sec, err);
        }
    };
    let meeting = state.store.get(meeting_id)?;
    let audio_path = state.store.audio_path(meeting_id);
    let updated = meeting
        .with_transcript(transcript)
        .with_duration(duration_sec)
        .with_audio_path(audio_path.clone())
        .with_dropped_audio_chunks(dropped_chunks);
    state.store.save(&updated)?;

    // Durability artifacts are cleaned up only AFTER the finished meeting
    // is durably saved — the transcript now lives in `meeting.json`, so the
    // journal and manifest have served their purpose. A cleanup failure is
    // logged, never fatal (the meeting is already saved); a stale manifest
    // is what the startup recovery pass reconciles.
    if let Err(err) =
        session_manifest::delete_manifest(&state.store.session_manifest_path(meeting_id))
    {
        eprintln!("myna-app: failed to delete session manifest for meeting {meeting_id}: {err}");
    }
    if let Err(err) =
        session_manifest::delete_journal(&state.store.transcript_journal_path(meeting_id))
    {
        eprintln!("myna-app: failed to delete transcript journal for meeting {meeting_id}: {err}");
    }

    if dropped_chunks > 0 {
        emit_dropped_audio_warning(app);
    }

    Ok(MeetingDto::from_meeting(
        updated,
        crate::ingest::has_audio(&audio_path),
        crate::ingest::has_audio(&state.store.system_track_path(meeting_id)),
    ))
}

/// Stop-path fallback: the recording worker died mid-capture, so
/// [`RecordingSession::stop`] returned `Err` and no in-memory transcript
/// came back. Rather than losing the meeting entirely (the pre-Phase-3
/// behavior: propagate the error, leaving the manifest and journal — and
/// every finalized segment — stranded on disk), salvage it from disk:
/// repair the unfinalized WAV headers, fold the transcript journal, take
/// the duration from the session's elapsed wall-clock (floored against the
/// repaired audio and journal), persist the meeting, and clean up the
/// durability artifacts. The meeting is then returned as `Ok` — saved, not
/// lost — and the original failure is announced as a non-fatal [`APP_ERROR`]
/// warning (code `RECORDING_ENDED_WITH_ERROR`) carrying the worker's error
/// message, exactly like [`emit_dropped_audio_warning`] announces partial
/// transcript loss. If the salvage itself fails (e.g. an unreadable
/// `meeting.json`), the original worker error surfaces unchanged and the
/// artifacts remain for startup recovery to retry.
///
/// The emission closure is injected into
/// [`recovery::salvage_recording_after_stop_failure`] so the persistence +
/// emission contract is testable without a live app — the
/// [`crate::session::announce_resolved_system_source`] precedent.
fn recover_after_failed_stop(
    app: &AppHandle,
    state: &State<'_, AppState>,
    meeting_id: MeetingId,
    elapsed_sec: f32,
    original_error: AppError,
) -> Result<MeetingDto, AppError> {
    let salvage = recovery::salvage_recording_after_stop_failure(
        &state.store,
        meeting_id,
        elapsed_sec,
        &original_error,
        |payload| {
            let _ = app.emit(APP_ERROR, payload);
        },
    );
    match salvage {
        Ok(meeting) => {
            let audio_path = state.store.audio_path(meeting_id);
            Ok(MeetingDto::from_meeting(
                meeting,
                crate::ingest::has_audio(&audio_path),
                crate::ingest::has_audio(&state.store.system_track_path(meeting_id)),
            ))
        }
        Err(salvage_err) => {
            eprintln!(
                "myna-app: stop-failure salvage failed for meeting {meeting_id}: {salvage_err} \
                 — surfacing the original recording error"
            );
            Err(original_error)
        }
    }
}

/// Cancels the active recording, discarding its audio and meeting record
/// entirely.
///
/// `async fn` for the same reason as [`stop_recording`]: it joins the same
/// worker threads via [`RecordingSession::stop`].
#[tauri::command]
pub async fn cancel_recording(app: AppHandle) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || cancel_recording_blocking(&app))
        .await
        .unwrap_or_else(|_| {
            Err(AppError::Store(
                "cancel_recording worker thread panicked".to_string(),
            ))
        })
}

fn cancel_recording_blocking(app: &AppHandle) -> Result<(), AppError> {
    let state = app.state::<AppState>();
    // Same `stopping` marker discipline as `stop_recording_blocking`
    // (MINOR-1): the guard is held until the discard below completes.
    let (session, _stopping) = take_session(&state)?;
    let meeting_id = session.meeting_id;
    let source = session.source;
    let system_source = session.system_source();

    emit_recording_state(
        app,
        Some(meeting_id),
        RecordingState::Stopping,
        source,
        system_source.clone(),
    );
    let stop_result = session.stop();
    emit_recording_state(app, None, RecordingState::Idle, source, system_source);
    // End-of-operation STT idle-TTL restart — see `stop_recording_blocking`.
    state.touch_stt_last_used();

    discard_cancelled_meeting(&state.store, meeting_id, stop_result)
}

/// The cancel path's discard contract (MINOR-2), split from the command so
/// it is unit-testable without a live `AppHandle`.
///
/// The user explicitly threw this recording away, so the meeting is
/// deleted whether or not the worker shut down cleanly: the `session.json`
/// manifest and the transcript journal live INSIDE the meeting directory,
/// so the delete removes them too and startup recovery can never
/// resurrect a discarded meeting. The pre-fix `stop_result?` early return
/// skipped exactly that delete on a dead worker — the manifest survived
/// and the next boot folded the "orphan" back into a meeting the user had
/// already discarded. The original worker error still surfaces to the
/// caller; a failed delete is logged (the directory then genuinely is an
/// orphan for recovery to fold, which beats silently losing it).
fn discard_cancelled_meeting(
    store: &FsMeetingStore,
    meeting_id: MeetingId,
    stop_result: Result<(myna_stt::Transcript, u32), AppError>,
) -> Result<(), AppError> {
    match stop_result {
        Ok(_) => store.delete(meeting_id),
        Err(err) => {
            if let Err(delete_err) = store.delete(meeting_id) {
                eprintln!(
                    "myna-app: failed to discard meeting {meeting_id} after a failed cancel: \
                     {delete_err} — startup recovery may fold it as an orphan"
                );
            }
            Err(err)
        }
    }
}

/// Returns the current recording state, and the active meeting id if any.
///
/// Stays synchronous: this only locks the in-memory `Mutex<Option<
/// RecordingSession>>` and reads already-resolved fields off it — no I/O,
/// microseconds-scale — so there is nothing to move off the main thread.
#[tauri::command]
pub fn recording_state(state: State<'_, AppState>) -> Result<RecordingStatePayload, AppError> {
    // Idle-model eviction hook (boot/reload path): a webview reload after
    // an idle meeting gets the `recording_state` snapshot, and this is the
    // natural moment to hand a TTL-expired STT engine back to the OS. The
    // check is all-`try_lock`/non-blocking and refuses while a session or
    // import is live, so it can never interfere with the `stopping`
    // contract below. See `commands::devices::list_input_devices` for the
    // periodic half of this hook.
    state.evict_stt_if_idle();
    recording_state_payload(&state)
}

/// The [`recording_state`] contract, split from the `#[tauri::command]`
/// wrapper so the idle/recording/stopping transitions are testable against
/// a plain `AppState` (constructing a `tauri::State` needs a live app —
/// same seam as `recovery::salvage_recording_after_stop_failure`).
///
/// The three-way rule: a session in the slot is `Recording`; an empty
/// slot with a stop/cancel still finalizing is `Stopping`, carrying the
/// meeting id and the elapsed clock frozen at take time (the UI's resume
/// branch keys off `meetingId` being present — without the marker this
/// state was unreachable from a poll, MINOR-1); anything else is `Idle`.
fn recording_state_payload(state: &AppState) -> Result<RecordingStatePayload, AppError> {
    let session_slot = lock_session(state)?;
    if let Some(session) = session_slot.as_ref() {
        return Ok(RecordingStatePayload {
            meeting_id: Some(session.meeting_id.to_string()),
            state: RecordingState::Recording,
            source: session.source,
            system_source: session.system_source().map(AudioSourceDto::from),
            // The command is the one place the live clock is available;
            // events never carry it (see `RecordingStatePayload`). Lets a
            // reloaded webview restore the running timer immediately.
            elapsed_sec: Some(session.elapsed_sec()),
        });
    }
    drop(session_slot);
    Ok(match state.stopping() {
        Some(stopping) => RecordingStatePayload {
            meeting_id: Some(stopping.meeting_id.to_string()),
            state: RecordingState::Stopping,
            // The session is gone from the slot, so the live source is no
            // longer readable; the UI's `stopping` branch ignores both.
            source: CaptureSource::default(),
            system_source: None,
            elapsed_sec: Some(stopping.elapsed_sec),
        },
        None => RecordingStatePayload {
            meeting_id: None,
            state: RecordingState::Idle,
            source: CaptureSource::default(),
            system_source: None,
            elapsed_sec: None,
        },
    })
}

/// Returns the transcript finalized SO FAR for the recording currently in
/// progress, read from its durability journal, or `None` when `meeting_id`
/// is not the active session (idle, or a different meeting).
///
/// This is the query half of the resilience contract: a webview reload
/// mid-meeting rebuilds the visible transcript from disk instead of relying
/// on having been subscribed to every `transcript://final` event. It stays
/// synchronous: the journal is small (a few hundred short lines), read once
/// per reload, and locking the session slot mirrors `recording_state`.
#[tauri::command]
pub fn get_live_transcript(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<Option<TranscriptDto>, AppError> {
    let active_id = {
        let session_slot = lock_session(&state)?;
        session_slot
            .as_ref()
            .filter(|session| session.meeting_id.to_string() == meeting_id)
            .map(|session| session.meeting_id)
    };
    let Some(active_id) = active_id else {
        return Ok(None);
    };
    let journal_path = state.store.transcript_journal_path(active_id);
    let transcript = session_manifest::read_journal(&journal_path)?;
    Ok(Some(TranscriptDto::from(transcript)))
}

/// Resolves `device` by name, or the host's default input device when
/// `None`.
fn resolve_device(device: Option<String>) -> Result<DeviceInfo, AppError> {
    match device {
        Some(name) => myna_audio::list_input_devices()?
            .into_iter()
            .find(|candidate| candidate.name == name)
            .ok_or_else(|| AppError::NotFound(format!("input device '{name}'"))),
        None => Ok(myna_audio::default_input_device()?),
    }
}

pub(crate) fn lock_session<'a>(
    state: &'a AppState,
) -> Result<MutexGuard<'a, Option<RecordingSession>>, AppError> {
    state
        .session
        .lock()
        .map_err(|_| AppError::Store("recording session lock poisoned".to_string()))
}

/// Takes the active session out of `state`, failing with
/// [`AppError::Busy`] when none is in progress.
///
/// Marks the stop/cancel finalization in flight (`begin_stopping`) *while
/// the session lock is still held and before the session leaves the slot*
/// — so there is no observable instant where `recording_state` sees an
/// empty slot without the `stopping` marker (MINOR-1). The returned
/// [`StoppingGuard`] clears the marker when the caller's save / delete /
/// cleanup completes (or the command panics / early-returns via `?`).
fn take_session<'a>(
    state: &'a State<'_, AppState>,
) -> Result<(RecordingSession, StoppingGuard<'a>), AppError> {
    let mut session_slot = lock_session(state)?;
    guard_stop(session_slot.is_some())?;
    let existing = session_slot
        .as_ref()
        .expect("guard_stop confirmed a session is present");
    let marker = state.begin_stopping(existing.meeting_id, existing.elapsed_sec());
    let session = session_slot
        .take()
        .expect("guard_stop confirmed a session is present");
    Ok((session, marker))
}

/// Emits [`APP_ERROR`] warning that one or more audio chunks were silently
/// dropped during the just-finished recording (see
/// [`crate::session::DecodeChannel`]). The recording's audio file itself is
/// unaffected — the WAV write happens before the decode handoff — so this
/// is recoverable by re-transcribing rather than a hard failure.
fn emit_dropped_audio_warning(app: &AppHandle) {
    let payload = ErrorPayload {
        code: DROPPED_AUDIO_CHUNKS_CODE.to_string(),
        message: DROPPED_AUDIO_CHUNKS_MESSAGE.to_string(),
    };
    let _ = app.emit(APP_ERROR, payload);
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::session_manifest::{self, JournalWriter, SessionManifest};
    use crate::store::folder_store::FsFolderStore;

    fn temp_store(dir: &Path) -> FsMeetingStore {
        FsMeetingStore::new(dir)
    }

    fn temp_state(dir: &Path) -> AppState {
        AppState::new(
            FsMeetingStore::new(dir),
            FsFolderStore::new(dir.to_path_buf()),
        )
    }

    // --- recording_state payload contract (MINOR-1) -------------------------

    #[test]
    fn recording_state_is_idle_with_no_session_and_no_stop_in_flight() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = temp_state(dir.path());

        let payload = recording_state_payload(&state).expect("payload");

        assert_eq!(payload.state, RecordingState::Idle);
        assert_eq!(payload.meeting_id, None);
        assert_eq!(payload.elapsed_sec, None);
    }

    #[test]
    fn recording_state_reports_stopping_between_take_and_completion() {
        // The MINOR-1 contract: `stop_recording`/`cancel_recording` take the
        // session out of the slot *before* the multi-second final-decode
        // join, so a webview reloading during that window must see
        // `stopping` — carrying the meeting id the UI's resume branch keys
        // off — never a false `idle`.
        let dir = tempfile::tempdir().expect("tempdir");
        let state = temp_state(dir.path());
        let meeting_id = MeetingId::new();

        let guard = state.begin_stopping(meeting_id, 42.0);
        let payload = recording_state_payload(&state).expect("payload while stopping");
        assert_eq!(
            payload.state,
            RecordingState::Stopping,
            "an empty slot plus an in-flight stop must report `stopping`"
        );
        assert_eq!(
            payload.meeting_id.as_deref(),
            Some(meeting_id.to_string().as_str()),
            "the stopping payload must carry the meeting id (the UI's \
             `meetingId === null` guard otherwise skips the branch)"
        );
        assert_eq!(payload.elapsed_sec, Some(42.0));

        // The guard releasing (i.e. save/delete/cleanup completing) ends
        // the stopping window.
        drop(guard);
        let payload = recording_state_payload(&state).expect("payload after completion");
        assert_eq!(payload.state, RecordingState::Idle);
        assert_eq!(payload.meeting_id, None);
    }

    // --- cancel discard contract (MINOR-2) ----------------------------------

    /// Seeds a meeting exactly as a live recording leaves it: dir with
    /// `meeting.json`, `session.json`, journal, and `audio.wav`.
    fn seed_live_recording(store: &FsMeetingStore) -> MeetingId {
        let meeting = store.create("to be discarded").expect("create");
        let id = meeting.id;
        session_manifest::write_manifest(
            &store.session_manifest_path(id),
            &SessionManifest::new(&id.to_string(), CaptureSource::Microphone, None),
        )
        .expect("write manifest");
        let mut journal =
            JournalWriter::create(&store.transcript_journal_path(id)).expect("create journal");
        journal
            .append(&myna_stt::TranscriptSegment {
                start_sec: 0.0,
                end_sec: 1.0,
                text: "journaled".to_string(),
                speaker: myna_stt::Speaker::me(),
                speaker_pinned: false,
            })
            .expect("append");
        drop(journal);
        std::fs::write(store.audio_path(id), b"RIFF....WAVEfmt ").expect("write audio");
        id
    }

    #[test]
    fn cancel_with_a_dead_worker_still_discards_the_meeting_dir() {
        // MINOR-2: the user explicitly discarded this recording. A dead
        // worker must not turn the discard into a resurrection — the
        // manifest and journal live INSIDE the meeting dir, so deleting
        // the dir cleans them up too, and startup recovery finds nothing.
        let dir = tempfile::tempdir().expect("tempdir");
        let store = temp_store(dir.path());
        let id = seed_live_recording(&store);
        let original = AppError::Store("recording worker thread panicked".to_string());

        let result = discard_cancelled_meeting(&store, id, Err(original));

        assert!(
            matches!(&result, Err(AppError::Store(msg)) if msg.contains("panicked")),
            "the original worker error must still surface to the user, got: {result:?}"
        );
        assert!(
            !store.session_manifest_path(id).exists(),
            "the manifest must not survive a discard — startup recovery would \
             resurrect a meeting the user cancelled"
        );
        assert!(
            !dir.path().join("meetings").join(id.to_string()).exists(),
            "the whole meeting dir must be gone"
        );

        // And recovery genuinely finds nothing to resurrect.
        crate::recovery::recover_orphaned_sessions(&store);
        assert!(
            store.get(id).is_err(),
            "a discarded meeting must not come back"
        );
        assert!(
            store.list().expect("list").is_empty(),
            "a discarded meeting must not be listed"
        );
    }

    #[test]
    fn cancel_with_a_healthy_worker_deletes_the_meeting() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = temp_store(dir.path());
        let id = seed_live_recording(&store);

        discard_cancelled_meeting(&store, id, Ok((myna_stt::Transcript::default(), 0)))
            .expect("a clean cancel is Ok");

        assert!(!dir.path().join("meetings").join(id.to_string()).exists());
    }
}
