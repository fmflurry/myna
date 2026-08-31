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
use crate::dto::{AudioSourceDto, MeetingDto};
use crate::error::AppError;
use crate::events::{emit_recording_state, ErrorPayload, RecordingStatePayload, APP_ERROR};
use crate::paths;
use crate::session::{
    guard_start, guard_stop, resolve_capture_source, resolve_system_source_id, AudioPaths,
    CaptureSelection, RecordingSession, RecordingState,
};
use crate::state::AppState;
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
        system_source_id: effective_system_source_id,
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
    let session = take_session(&state)?;
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

    let (transcript, dropped_chunks) = stop_result?;
    let meeting = state.store.get(meeting_id)?;
    let audio_path = state.store.audio_path(meeting_id);
    let updated = meeting
        .with_transcript(transcript)
        .with_duration(duration_sec)
        .with_audio_path(audio_path.clone())
        .with_dropped_audio_chunks(dropped_chunks);
    state.store.save(&updated)?;

    if dropped_chunks > 0 {
        emit_dropped_audio_warning(app);
    }

    Ok(MeetingDto::from_meeting(
        updated,
        crate::ingest::has_audio(&audio_path),
        crate::ingest::has_audio(&state.store.system_track_path(meeting_id)),
    ))
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
    let session = take_session(&state)?;
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
    stop_result?;

    state.store.delete(meeting_id)
}

/// Returns the current recording state, and the active meeting id if any.
///
/// Stays synchronous: this only locks the in-memory `Mutex<Option<
/// RecordingSession>>` and reads already-resolved fields off it — no I/O,
/// microseconds-scale — so there is nothing to move off the main thread.
#[tauri::command]
pub fn recording_state(state: State<'_, AppState>) -> Result<RecordingStatePayload, AppError> {
    let session_slot = lock_session(&state)?;
    Ok(match session_slot.as_ref() {
        Some(session) => RecordingStatePayload {
            meeting_id: Some(session.meeting_id.to_string()),
            state: RecordingState::Recording,
            source: session.source,
            system_source: session.system_source().map(AudioSourceDto::from),
        },
        None => RecordingStatePayload {
            meeting_id: None,
            state: RecordingState::Idle,
            source: CaptureSource::default(),
            system_source: None,
        },
    })
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
    state: &'a State<'_, AppState>,
) -> Result<MutexGuard<'a, Option<RecordingSession>>, AppError> {
    state
        .session
        .lock()
        .map_err(|_| AppError::Store("recording session lock poisoned".to_string()))
}

/// Takes the active session out of `state`, failing with
/// [`AppError::Busy`] when none is in progress.
fn take_session(state: &State<'_, AppState>) -> Result<RecordingSession, AppError> {
    let mut session_slot = lock_session(state)?;
    guard_stop(session_slot.is_some())?;
    Ok(session_slot
        .take()
        .expect("guard_stop confirmed a session is present"))
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
