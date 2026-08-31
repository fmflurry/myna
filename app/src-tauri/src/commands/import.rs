//! Audio-import commands: importing an external audio file as a new
//! meeting, re-transcribing an existing meeting's audio (optionally over a
//! newly supplied source file), and cancelling either.
//!
//! `import_audio` and `retranscribe_meeting` are `async fn`s whose entire
//! synchronous body runs inside a single
//! [`tauri::async_runtime::spawn_blocking`] closure — the same contract
//! `commands::recording` and `commands::summary` document: the busy guard
//! ([`AppState::begin_import`]/[`AppState::end_import`]) is taken
//! synchronously, before any `.await`, so it is never held across one.
//!
//! Both pipelines stream the source WAV through
//! [`crate::ingest::transcribe_wav_streaming`] with live partials disabled
//! ([`StreamerOptions::emit_partials`] `false`) — only [`TRANSCRIPT_FINAL`]
//! and throttled [`IMPORT_PROGRESS`] events are emitted while ingesting.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use tauri::{AppHandle, Emitter, Manager, State};
use time::OffsetDateTime;

use myna_stt::{
    relabel_others, DiarizeResult, SimulatedStreamer, Speaker, StreamerOptions, SttEngine,
    SttError, SttEvent, Transcript, TranscriptSegment, VadConfig,
};

use crate::commands::meetings::resolve_new_title;
use crate::commands::recording::lock_session;
use crate::domain::MeetingId;
use crate::dto::MeetingDto;
use crate::error::AppError;
use crate::events::{
    FinalPayload, ImportPhase, ImportProgressPayload, IMPORT_PROGRESS, TRANSCRIPT_FINAL,
};
use crate::ingest;
use crate::paths;
use crate::session::{guard_not_recording, LevelThrottle};
use crate::state::AppState;
use crate::store::MeetingStore;

/// Minimum spacing, in milliseconds, between [`IMPORT_PROGRESS`] emissions
/// while transcribing — mirrors [`crate::session::LEVEL_EMIT_INTERVAL_MS`]'s
/// role for recording levels.
const IMPORT_PROGRESS_INTERVAL_MS: u64 = 250;

/// Directory name (under the resolved models root) containing the Silero
/// VAD model artifact. Mirrors `commands::recording`'s constant of the same
/// name — not reused directly because that one is private to its module.
const VAD_MODEL_DIR_NAME: &str = "silero-vad";
/// File name of the Silero VAD model, within [`VAD_MODEL_DIR_NAME`].
const VAD_MODEL_FILE_NAME: &str = "silero_vad.onnx";

/// Imports an external audio file (`path`) as a brand-new meeting titled
/// `title` (a timestamp-derived default when empty, via
/// [`resolve_new_title`]), converts it to Myna's canonical 16 kHz mono WAV,
/// and transcribes it.
///
/// The new meeting is created and persisted *before* conversion begins, so
/// a crash or cancellation mid-ingest leaves a recoverable, audio-only
/// meeting rather than an orphaned temporary file.
///
/// Fails with [`AppError::Busy`] if an import/re-transcribe is already
/// running, or if a recording is currently active.
///
/// `async fn`: conversion and transcription of a real meeting's audio is
/// easily seconds-to-minutes, so the whole body runs inside
/// [`tauri::async_runtime::spawn_blocking`] via [`import_audio_blocking`],
/// exactly like `commands::recording::start_recording`.
#[tauri::command]
pub async fn import_audio(
    app: AppHandle,
    path: String,
    title: Option<String>,
) -> Result<MeetingDto, AppError> {
    tauri::async_runtime::spawn_blocking(move || import_audio_blocking(&app, path, title))
        .await
        .unwrap_or_else(|_| {
            Err(AppError::Store(
                "import_audio worker thread panicked".to_string(),
            ))
        })
}

/// Synchronous body of [`import_audio`], run on a blocking-pool thread.
fn import_audio_blocking(
    app: &AppHandle,
    path: String,
    title: Option<String>,
) -> Result<MeetingDto, AppError> {
    let state = app.state::<AppState>();
    let recording_active = lock_session(&state)?.is_some();
    ingest::guard_import(state.import_busy(), recording_active)?;
    state.begin_import()?;

    let result = run_import(app, &state, path, title);
    state.end_import();
    result
}

/// Does the actual work of [`import_audio`], factored out so the caller can
/// unconditionally release the busy flag afterwards regardless of outcome —
/// mirrors `commands::summary::run_summarization`.
fn run_import(
    app: &AppHandle,
    state: &State<'_, AppState>,
    path: String,
    title: Option<String>,
) -> Result<MeetingDto, AppError> {
    let effective_title = resolve_new_title(&title.unwrap_or_default(), OffsetDateTime::now_utc());
    let meeting = state.store.create(&effective_title)?;
    let id = meeting.id;
    let audio_dest = state.store.audio_path(id);

    // Validated against *this* new meeting's destination, not a blanket
    // "anywhere under the meetings root" check — a source file that
    // happens to live inside a different, existing meeting's directory is
    // a legitimate cross-meeting import (see `ingest::validate_source_path`
    // doc comment). A freshly minted meeting id's `audio.wav` can never
    // equal an existing file, so this only ever refuses a genuinely
    // malformed/missing/wrong-extension source here.
    let source = ingest::validate_source_path(Path::new(&path), &audio_dest)?;

    let cancel = Arc::clone(&state.cancel_import);

    emit_import_progress(app, id, ImportPhase::Converting, 0.0, 0.0);
    let total_sec = ingest::convert_to_canonical_wav(&source, &audio_dest, &cancel)?;

    let mut streamer = build_streamer(app, state)?;
    let mut throttle = LevelThrottle::new(IMPORT_PROGRESS_INTERVAL_MS);

    let mut on_event = |event: SttEvent| {
        if let SttEvent::Final { segment } = event {
            emit_final(app, id, segment);
        }
    };
    let mut on_progress = |processed_sec: f32, total_sec: f32| {
        if throttle.should_emit(Instant::now()) {
            emit_import_progress(app, id, ImportPhase::Transcribing, processed_sec, total_sec);
        }
    };

    let transcript = ingest::transcribe_wav_streaming(
        &audio_dest,
        &mut streamer,
        &cancel,
        &mut on_event,
        &mut on_progress,
    )?;

    let updated = meeting
        .with_transcript(transcript)
        .with_duration(total_sec)
        .with_audio_path(audio_dest.clone());
    state.store.save(&updated)?;

    emit_import_progress(app, id, ImportPhase::Done, total_sec, total_sec);

    Ok(MeetingDto::from_meeting(
        updated,
        ingest::has_audio(&audio_dest),
        ingest::has_audio(&state.store.system_track_path(id)),
    ))
}

/// Re-transcribes `meeting_id`'s audio: either the meeting's own existing
/// `audio.wav` (when `path` is `None`), or a freshly supplied source file
/// converted over it (when `path` is `Some`).
///
/// The previous transcript, if any, is backed up to
/// `transcript.previous.json` (see [`crate::ingest::backup_transcript`])
/// before the new one is persisted, so a bad re-transcription never
/// silently destroys the previous result.
///
/// Fails with [`AppError::Busy`] if `meeting_id` is the meeting the active
/// recording session is currently recording into (see
/// [`guard_not_recording`]), or if an import/re-transcribe is already
/// running.
///
/// `async fn` for the same reason as [`import_audio`].
#[tauri::command]
pub async fn retranscribe_meeting(
    app: AppHandle,
    meeting_id: String,
    path: Option<String>,
) -> Result<MeetingDto, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        retranscribe_meeting_blocking(&app, meeting_id, path)
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Store(
            "retranscribe_meeting worker thread panicked".to_string(),
        ))
    })
}

/// Synchronous body of [`retranscribe_meeting`], run on a blocking-pool
/// thread.
fn retranscribe_meeting_blocking(
    app: &AppHandle,
    meeting_id: String,
    path: Option<String>,
) -> Result<MeetingDto, AppError> {
    let id = parse_meeting_id(&meeting_id)?;
    let state = app.state::<AppState>();

    let session_slot = lock_session(&state)?;
    let recording_active = session_slot.is_some();
    let active_meeting_id = session_slot.as_ref().map(|s| s.meeting_id);
    drop(session_slot);
    guard_not_recording(active_meeting_id, id)?;
    ingest::guard_import(state.import_busy(), recording_active)?;
    state.begin_import()?;

    let result = run_retranscribe(app, &state, id, path);
    state.end_import();
    result
}

/// Does the actual work of [`retranscribe_meeting`], factored out so the
/// caller can unconditionally release the busy flag afterwards regardless
/// of outcome.
///
/// Speaker attribution, in priority order (see
/// [`ingest::resolve_retranscribe_tracks`]):
/// 1. A replacement `path` was supplied — converted and transcribed as a
///    single source, stamped `Speaker::unknown()` (an externally supplied
///    file has no track separation, so no attribution was ever captured
///    for it).
/// 2. No replacement supplied, and the meeting's own `track-mic.wav` and/or
///    `track-system.wav` exist — each present track is decoded with its own
///    [`SimulatedStreamer`] (sharing one loaded [`SttEngine`]) and stamped
///    `Speaker::me()` / bare `Speaker::others()` respectively. A track
///    genuinely absent (mic-only capture, or the other track never present)
///    is never synthesized.
/// 3. No replacement supplied and neither track file exists — a legacy
///    meeting recorded before per-track capture existed, or a meeting
///    originally created via [`import_audio`] (which has no track
///    separation) — falls back to the meeting's own `audio.wav`, staged
///    through [`ingest::convert_to_canonical_wav`] (which handles both the
///    native-rate stereo shape new recordings write and the mono shape
///    legacy recordings/imports have) and stamped `Speaker::unknown()`. The
///    staged file is a scratch conversion for STT only and is discarded
///    afterwards — `audio_dest` itself is never replaced by it, unlike the
///    supplied-`path` branch above.
fn run_retranscribe(
    app: &AppHandle,
    state: &State<'_, AppState>,
    id: MeetingId,
    path: Option<String>,
) -> Result<MeetingDto, AppError> {
    let meeting = state.store.get(id)?;
    let audio_dest = state.store.audio_path(id);
    let cancel = Arc::clone(&state.cancel_import);
    let (engine, vad_cfg) = build_engine_and_vad_cfg(app, state)?;

    // A supplied replacement source, or a fallback conversion of the
    // meeting's own `audio.wav` (case 3 above), is converted into a
    // *staging* path, never `audio_dest` directly: a cancellation (or any
    // other failure) mid-conversion or mid-transcribe must leave the
    // meeting's existing `audio.wav` and transcript byte-for-byte untouched.
    // Only the supplied-replacement staged file is ever promoted over
    // `audio_dest` (once transcription of it has fully succeeded, below) —
    // the fallback-conversion staged file is always discarded instead.
    let (transcript, total_sec, promote_staged) = match path {
        Some(supplied) => {
            // Validated against *this* meeting's own destination: refuses
            // only true self-overwrite (re-supplying this same meeting's
            // `audio.wav` as its own "replacement"), not every file that
            // happens to live under the meetings root.
            let source = ingest::validate_source_path(Path::new(&supplied), &audio_dest)?;
            let staged = audio_dest.with_extension("wav.staged");
            emit_import_progress(app, id, ImportPhase::Converting, 0.0, 0.0);
            ingest::convert_to_canonical_wav(&source, &staged, &cancel)?;

            let tracks = vec![ingest::SpeakerTrack {
                path: staged.clone(),
                speaker: Speaker::unknown(),
            }];
            match track_transcribe(app, id, &tracks, &engine, &vad_cfg, &cancel) {
                Ok((transcript, total_sec)) => (transcript, total_sec, Some(staged)),
                Err(err) => {
                    let _ = fs::remove_file(&staged);
                    return Err(err);
                }
            }
        }
        None => {
            let mic_track = state.store.mic_track_path(id);
            let system_track = state.store.system_track_path(id);
            let mut tracks = ingest::resolve_retranscribe_tracks(&mic_track, &system_track);

            let fallback_staged = if tracks.is_empty() {
                // Neither track file exists: fall back to `audio_dest`
                // itself, staged through the same canonicalizing conversion
                // an externally supplied source would go through.
                let existing_audio = if ingest::has_audio(&audio_dest) {
                    Some(audio_dest.clone())
                } else {
                    None
                };
                ingest::resolve_reimport_source(existing_audio, None)?;

                let staged = audio_dest.with_extension("wav.staged");
                emit_import_progress(app, id, ImportPhase::Converting, 0.0, 0.0);
                ingest::convert_to_canonical_wav(&audio_dest, &staged, &cancel)?;
                tracks.push(ingest::SpeakerTrack {
                    path: staged.clone(),
                    speaker: Speaker::unknown(),
                });
                Some(staged)
            } else {
                None
            };

            let transcribe_result = track_transcribe(app, id, &tracks, &engine, &vad_cfg, &cancel);
            if let Some(staged) = &fallback_staged {
                let _ = fs::remove_file(staged);
            }
            let (transcript, total_sec) = transcribe_result?;
            (transcript, total_sec, None)
        }
    };

    if let Some(staged) = &promote_staged {
        fs::rename(staged, &audio_dest)?;
    }

    if let Some(previous_transcript) = &meeting.transcript {
        let meeting_dir = audio_dest
            .parent()
            .ok_or_else(|| AppError::Path("audio path has no parent directory".to_string()))?;
        ingest::backup_transcript(meeting_dir, previous_transcript, &meeting.speaker_names)?;
    }

    // The fresh transcript invalidates every summary generated from the
    // old one, and clears whatever dropped-audio-chunk count the previous
    // recording/transcribe left behind — this transcribe pass is clean.
    // `speaker_names` is cleared too: after re-clustering, `others:1` is
    // likely a different human, and displaying an old name over someone
    // else's words would be the app lying about who spoke. The old map was
    // just snapshotted into `transcript.previous.json` above, so it's
    // recoverable on disk even though it's gone from the live meeting.
    let updated = meeting
        .with_all_summaries_stale()
        .with_transcript(transcript)
        .with_duration(total_sec)
        .with_audio_path(audio_dest.clone())
        .with_dropped_audio_chunks(0)
        .with_speaker_names(BTreeMap::new());
    state.store.save(&updated)?;

    emit_import_progress(app, id, ImportPhase::Done, total_sec, total_sec);

    Ok(MeetingDto::from_meeting(
        updated,
        ingest::has_audio(&audio_dest),
        ingest::has_audio(&state.store.system_track_path(id)),
    ))
}

/// Requests cancellation of the in-flight import or re-transcribe, if any.
///
/// The running [`crate::ingest::transcribe_wav_streaming`] call observes
/// the shared flag between blocks and returns an error; the caller then
/// persists nothing, leaving the meeting exactly as it was before the call
/// (audio-only for an import, previous transcript intact for a
/// re-transcribe).
///
/// Stays synchronous: a single [`std::sync::atomic::AtomicBool`] store is
/// microseconds-scale and does no I/O — mirrors
/// `commands::summary::cancel_summarization`.
#[tauri::command]
pub fn cancel_import(state: State<'_, AppState>) {
    state.cancel_import.store(true, Ordering::SeqCst);
}

/// Diarizes `meeting_id`'s system-audio track (`track-system.wav`) and
/// relabels its transcript's bare `others` segments into per-speaker
/// `others:N` labels via [`relabel_others`] — see that function's docs for
/// the confidence rule this defers to entirely; nothing here second-guesses
/// it.
///
/// User-triggered only: diarization never runs automatically (not from
/// `stop_recording`, not from any other command) — the user explicitly
/// decides when to spend the CPU/time on it. Re-runnable: `track-system.wav`
/// is immutable once written, so re-running over the same meeting is
/// deterministic.
///
/// Fails with [`AppError::Busy`] if an import/re-transcribe is already
/// running, or if a recording is currently active — diarization loads its
/// own models and contends for the same CPU cores those other operations
/// already use (see [`ingest::guard_import`]). Fails with
/// [`AppError::NotFound`] when the meeting has no `track-system.wav` (a
/// mic-only recording, or a legacy/imported meeting with no track
/// separation) — there is nothing to diarize.
///
/// Fail-soft: any diarization error (model load, or the decode itself) is
/// surfaced as `Err` without ever writing a partial or empty transcript —
/// [`apply_diarize_result`] only ever returns a relabeled transcript once
/// diarization has *fully* succeeded, and [`run_diarize`] only calls
/// [`crate::store::MeetingStore::save`] with that result, never before.
///
/// Cancellation is boundary-only: [`myna_stt::Diarizer::diarize_wav`] is one
/// blocking FFI call with no cancellation hook, so [`AppState::cancel_import`]
/// can only be observed *before* the call starts and *after* it returns —
/// never mid-call. A cancellation requested while diarization is in flight
/// is only honored once that call completes; its result is then discarded
/// rather than persisted.
///
/// `async fn` for the same reason as [`import_audio`]/[`retranscribe_meeting`]:
/// model load plus the decode itself is easily seconds-scale.
#[tauri::command]
pub async fn diarize_meeting(app: AppHandle, meeting_id: String) -> Result<MeetingDto, AppError> {
    tauri::async_runtime::spawn_blocking(move || diarize_meeting_blocking(&app, meeting_id))
        .await
        .unwrap_or_else(|_| {
            Err(AppError::Store(
                "diarize_meeting worker thread panicked".to_string(),
            ))
        })
}

/// Synchronous body of [`diarize_meeting`], run on a blocking-pool thread.
fn diarize_meeting_blocking(app: &AppHandle, meeting_id: String) -> Result<MeetingDto, AppError> {
    let id = parse_meeting_id(&meeting_id)?;
    let state = app.state::<AppState>();

    let recording_active = lock_session(&state)?.is_some();
    ingest::guard_import(state.import_busy(), recording_active)?;
    state.begin_import()?;

    let result = run_diarize(app, &state, id);
    state.end_import();
    result
}

/// Does the actual work of [`diarize_meeting`], factored out so the caller
/// can unconditionally release the busy flag afterwards regardless of
/// outcome — mirrors [`run_retranscribe`].
fn run_diarize(
    app: &AppHandle,
    state: &State<'_, AppState>,
    id: MeetingId,
) -> Result<MeetingDto, AppError> {
    let meeting = state.store.get(id)?;
    let audio_dest = state.store.audio_path(id);
    let system_track = state.store.system_track_path(id);
    guard_system_track_present(&system_track)?;

    // Boundary-only cancellation: see the "before"/"after" observation
    // points documented on `diarize_meeting`.
    if state.cancel_import.load(Ordering::SeqCst) {
        return Err(AppError::Cancelled);
    }

    let diarizer = state.diarizer(app)?;
    let diarize_result = diarizer.diarize_wav(&system_track).map_err(|err| {
        eprintln!("myna-app: diarization failed for meeting {id}: {err}");
        err
    });

    if state.cancel_import.load(Ordering::SeqCst) {
        return Err(AppError::Cancelled);
    }

    let transcript = meeting.transcript.clone().unwrap_or_default();
    let relabeled = apply_diarize_result(&transcript, diarize_result)?;

    let updated = meeting.with_transcript(relabeled);
    state.store.save(&updated)?;

    Ok(MeetingDto::from_meeting(
        updated,
        ingest::has_audio(&audio_dest),
        true,
    ))
}

/// Pure guard: `Err(NotFound)` when `system_track` doesn't exist on disk —
/// diarization has nothing to analyze (a mic-only recording, or a legacy/
/// imported meeting with no track separation). Extracted so this rejection
/// is unit-testable without a loaded [`myna_stt::Diarizer`] or `AppHandle`.
fn guard_system_track_present(system_track: &Path) -> Result<(), AppError> {
    if system_track.is_file() {
        Ok(())
    } else {
        Err(AppError::NotFound(
            "no system audio was captured for this meeting".to_string(),
        ))
    }
}

/// Applies a [`DiarizeResult`] to `transcript` via [`relabel_others`],
/// propagating `diarize_result`'s error untouched when diarization itself
/// failed rather than ever returning a partial or empty transcript. This is
/// the single seam [`run_diarize`] calls
/// [`crate::store::MeetingStore::save`] through, so it structurally
/// guarantees the fail-soft contract documented on [`diarize_meeting`]:
/// extracted so that contract is unit-testable with a synthetic `Err`,
/// without a loaded [`myna_stt::Diarizer`].
fn apply_diarize_result(
    transcript: &Transcript,
    diarize_result: Result<DiarizeResult, SttError>,
) -> Result<Transcript, AppError> {
    let result = diarize_result?;
    Ok(relabel_others(transcript, &result))
}

/// Builds a [`SimulatedStreamer`] with live partials disabled — only
/// [`SttEvent::Final`] events are ever produced during ingest, since the UI
/// has no use for a live partial hypothesis while importing a file that
/// isn't being spoken live.
fn build_streamer(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<SimulatedStreamer, AppError> {
    let (engine, vad_cfg) = build_engine_and_vad_cfg(app, state)?;
    Ok(SimulatedStreamer::with_options(
        engine,
        &vad_cfg,
        StreamerOptions {
            emit_partials: false,
        },
    )?)
}

/// Resolves the shared, already-loaded [`SttEngine`] and the [`VadConfig`]
/// every [`SimulatedStreamer`] built for ingest is constructed from.
/// Extracted from [`build_streamer`] so [`run_retranscribe`]'s speaker-aware,
/// possibly-multi-track pipeline can build more than one streamer — one per
/// present track — from the *same* engine `Arc` rather than loading a second
/// one (which would double RAM — see `crate::session`'s module docs for the
/// identical constraint on live recording).
fn build_engine_and_vad_cfg(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<(Arc<SttEngine>, VadConfig), AppError> {
    let engine = state.stt_engine(app)?;
    let vad_cfg = VadConfig {
        model_path: paths::models_root(app)
            .join(VAD_MODEL_DIR_NAME)
            .join(VAD_MODEL_FILE_NAME),
        ..VadConfig::default()
    };
    Ok((engine, vad_cfg))
}

/// Drives [`ingest::transcribe_tracks_streaming`] for [`run_retranscribe`],
/// wiring up a fresh [`LevelThrottle`] and the same [`TRANSCRIPT_FINAL`] /
/// [`IMPORT_PROGRESS`] event emission every ingest pipeline in this module
/// uses.
fn track_transcribe(
    app: &AppHandle,
    id: MeetingId,
    tracks: &[ingest::SpeakerTrack],
    engine: &Arc<SttEngine>,
    vad_cfg: &VadConfig,
    cancel: &AtomicBool,
) -> Result<(Transcript, f32), AppError> {
    let mut throttle = LevelThrottle::new(IMPORT_PROGRESS_INTERVAL_MS);

    let mut on_event = |event: SttEvent| {
        if let SttEvent::Final { segment } = event {
            emit_final(app, id, segment);
        }
    };
    let mut on_progress = |processed_sec: f32, total_sec: f32| {
        if throttle.should_emit(Instant::now()) {
            emit_import_progress(app, id, ImportPhase::Transcribing, processed_sec, total_sec);
        }
    };

    ingest::transcribe_tracks_streaming(
        tracks,
        engine,
        vad_cfg,
        cancel,
        &mut on_event,
        &mut on_progress,
    )
}

fn emit_import_progress(
    app: &AppHandle,
    meeting_id: MeetingId,
    phase: ImportPhase,
    processed_sec: f32,
    total_sec: f32,
) {
    let payload = ImportProgressPayload {
        meeting_id: meeting_id.to_string(),
        phase,
        processed_sec,
        total_sec,
    };
    let _ = app.emit(IMPORT_PROGRESS, payload);
}

fn emit_final(app: &AppHandle, meeting_id: MeetingId, segment: TranscriptSegment) {
    let payload = FinalPayload {
        meeting_id: meeting_id.to_string(),
        segment,
    };
    let _ = app.emit(TRANSCRIPT_FINAL, payload);
}

/// Parses a meeting id from its string form, surfacing an invalid id as
/// [`AppError::NotFound`] rather than a parse error.
fn parse_meeting_id(id: &str) -> Result<MeetingId, AppError> {
    id.parse().map_err(|_| AppError::NotFound(id.to_string()))
}

#[cfg(test)]
mod diarize_tests {
    use super::*;

    // --- guard_system_track_present ---------------------------------------

    #[test]
    fn guard_system_track_present_rejects_a_missing_track_file() {
        // Arrange: mirrors a mic-only recording — `track-system.wav` was
        // never written.
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("track-system.wav");

        // Act
        let err = guard_system_track_present(&missing).expect_err("should be NotFound");

        // Assert: variant is NotFound, and the message explains why plainly
        // enough to show the user, not just "not found".
        assert!(matches!(err, AppError::NotFound(_)));
        let message = err.to_string().to_lowercase();
        assert!(
            message.contains("system audio"),
            "message should explain the meeting has no system audio, got: {message}"
        );
    }

    #[test]
    fn guard_system_track_present_allows_an_existing_track_file() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");
        let track = dir.path().join("track-system.wav");
        std::fs::write(&track, b"RIFF....WAVEfmt ").expect("write fixture");

        // Act / Assert
        assert!(guard_system_track_present(&track).is_ok());
    }

    // --- apply_diarize_result: the fail-soft seam --------------------------

    #[test]
    fn apply_diarize_result_propagates_a_diarization_error_without_touching_the_transcript() {
        // Arrange: a transcript with real content, standing in for an
        // existing meeting's transcript that must survive a failed
        // detection untouched.
        let transcript = Transcript {
            segments: vec![TranscriptSegment {
                start_sec: 0.0,
                end_sec: 1.0,
                text: "hello".to_string(),
                speaker: Speaker::me(),
                speaker_pinned: false,
            }],
        };

        // Act: diarization itself failed (e.g. model load failure).
        let result = apply_diarize_result(&transcript, Err(SttError::DiarizeInit));

        // Assert: the error propagates untouched, and — since `run_diarize`
        // only calls `MeetingStore::save` with THIS function's `Ok` value —
        // this failure structurally never reaches the store, leaving the
        // meeting's on-disk transcript exactly as it was.
        assert!(
            matches!(result, Err(AppError::Stt(SttError::DiarizeInit))),
            "expected the diarization error to propagate, got: {result:?}"
        );
    }

    #[test]
    fn apply_diarize_result_relabels_the_transcript_on_success() {
        // Arrange: two speakers detected, one segment long/confident enough
        // for `relabel_others` to actually relabel — mirrors that
        // function's own confidence-rule tests rather than re-deriving them
        // here; this test only pins that a *successful* diarize result
        // reaches `relabel_others` at all.
        let transcript = Transcript {
            segments: vec![TranscriptSegment {
                start_sec: 0.0,
                end_sec: 5.0,
                text: "hello".to_string(),
                speaker: Speaker::others(),
                speaker_pinned: false,
            }],
        };
        let diarize_result = DiarizeResult {
            num_speakers: 2,
            segments: vec![myna_stt::DiarizeSegment {
                start_sec: 0.0,
                end_sec: 5.0,
                speaker_index: 0,
            }],
        };

        // Act
        let relabeled =
            apply_diarize_result(&transcript, Ok(diarize_result)).expect("should succeed");

        // Assert: the confident single-speaker segment picked up a
        // per-speaker label instead of staying bare `others`.
        assert_ne!(relabeled.segments[0].speaker.as_str(), "others");
    }
}
