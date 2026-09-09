//! Audio-import commands: importing an external audio file as a new
//! meeting, re-transcribing an existing meeting's audio (optionally over a
//! newly supplied source file), and cancelling either.
//!
//! `import_audio` and `retranscribe_meeting` are `async fn`s whose entire
//! synchronous body runs inside a single
//! [`tauri::async_runtime::spawn_blocking`] closure — the same contract
//! `commands::recording` and `commands::summary` document: the busy guard
//! ([`AppState::import_guard`], an RAII wrapper over
//! [`AppState::begin_import`]/[`AppState::end_import`] whose `Drop` releases
//! the flag even if the guarded body panics) is taken synchronously, before
//! any `.await`, so it is never held across one.
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
    align_words_to_diar, compact_speaker_indices, exclude_short_segments, post_merge,
    read_wav_to_f32, relabel_others_with_config, relabel_others_word_level, smooth_labels,
    DiarizeConfig, DiarizeResult, SimulatedStreamer, Speaker, StreamerOptions, SttEngine, SttError,
    SttEvent, Transcript, TranscriptSegment, VadConfig, WavBlockReader, Word,
};

use crate::commands::meetings::resolve_new_title;
use crate::commands::recording::lock_session;
use crate::diarize_judge::is_judge_enabled;
use crate::domain::{Meeting, MeetingId};
use crate::dto::MeetingDto;
use crate::error::AppError;
use crate::events::{
    FinalPayload, ImportPhase, ImportProgressPayload, IMPORT_PROGRESS, TRANSCRIPT_FINAL,
};
use crate::ingest;
use crate::paths;
use crate::session::{guard_not_recording, LevelThrottle};
use crate::state::{guard_import_vs_summary, AppState};
use crate::store::fs_store::FsMeetingStore;
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
    guard_import_vs_summary(state.summary_busy())?;
    let _guard = state.import_guard()?;

    let result = run_import(app, &state, path, title);
    // The STT engine was in use until this line; restart its idle-TTL
    // countdown from *now* so a re-recording within the TTL window still
    // reuses the warm engine (eviction only fires 10 min after last use).
    state.touch_stt_last_used();
    result
}

/// Does the actual work of [`import_audio`], factored out so the caller can
/// hold [`AppState::import_guard`] across the whole call — that guard's
/// `Drop` releases the busy flag regardless of outcome, including a panic
/// partway through this function, unlike a manual `end_import()` call which
/// a panic would skip entirely. Mirrors `commands::summary::run_summarization`.
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
    guard_import_vs_summary(state.summary_busy())?;
    let _guard = state.import_guard()?;

    let result = run_retranscribe(app, &state, id, path);
    // End-of-operation STT idle-TTL restart — see `import_audio_blocking`.
    state.touch_stt_last_used();
    result
}

/// Does the actual work of [`retranscribe_meeting`], factored out so the
/// caller can hold [`AppState::import_guard`] across the whole call — that
/// guard's `Drop` releases the busy flag regardless of outcome, including a
/// panic partway through this function.
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
    // `audio_dest`, and only via `promote_and_persist_retranscribe` below,
    // once transcription of it has fully succeeded AND the previous
    // transcript has been backed up AND the new meeting state has been
    // persisted — never eagerly. The fallback-conversion staged file is
    // always discarded instead, never promoted.
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

    // The fresh transcript invalidates every summary generated from the
    // old one, and clears whatever dropped-audio-chunk count the previous
    // recording/transcribe left behind — this transcribe pass is clean.
    // `speaker_names` is cleared too: after re-clustering, `others:1` is
    // likely a different human, and displaying an old name over someone
    // else's words would be the app lying about who spoke. The old map was
    // just snapshotted into `transcript.previous.json` below, so it's
    // recoverable on disk even though it's gone from the live meeting.
    let updated = meeting
        .with_all_summaries_stale()
        .with_transcript(transcript)
        .with_duration(total_sec)
        .with_audio_path(audio_dest.clone())
        .with_dropped_audio_chunks(0)
        .with_speaker_names(BTreeMap::new());
    let previous_transcript = meeting
        .transcript
        .as_ref()
        .map(|transcript| (transcript, &meeting.speaker_names));

    match &promote_staged {
        Some(staged) => {
            if let Err(err) = promote_and_persist_retranscribe(
                state.store.as_ref(),
                staged,
                &audio_dest,
                previous_transcript,
                &updated,
            ) {
                let _ = fs::remove_file(staged);
                return Err(err);
            }
        }
        None => {
            if let Some((previous_transcript, speaker_names)) = previous_transcript {
                let meeting_dir = audio_dest.parent().ok_or_else(|| {
                    AppError::Path("audio path has no parent directory".to_string())
                })?;
                ingest::backup_transcript(meeting_dir, previous_transcript, speaker_names)?;
            }
            state.store.save(&updated)?;
        }
    }

    emit_import_progress(app, id, ImportPhase::Done, total_sec, total_sec);

    Ok(MeetingDto::from_meeting(
        updated,
        ingest::has_audio(&audio_dest),
        ingest::has_audio(&state.store.system_track_path(id)),
    ))
}

/// Promotes a staged replacement audio file over `audio_dest` and persists
/// `updated`'s transcript, as a single all-or-nothing step for
/// [`run_retranscribe`]'s replace-audio branch.
///
/// Order is the whole fix: `previous_transcript`'s backup (via
/// [`ingest::backup_transcript`], when `Some`) and `updated`'s persistence
/// (via [`MeetingStore::save`]) both run *before* `staged` is ever promoted
/// over `audio_dest`. If either of those two steps fails, this returns `Err`
/// without ever touching `audio_dest` — it stays byte-identical to what it
/// was before the call, consistent with the still-old, unmodified persisted
/// transcript `store.get` would return. Only once both steps have fully
/// succeeded is `staged` renamed over `audio_dest`, a single same-directory
/// [`fs::rename`] the OS performs atomically (it either fully replaces
/// `audio_dest`'s contents or leaves them untouched, never a partial write).
///
/// This closes the bug this helper replaces: the old code renamed `staged`
/// over `audio_dest` unconditionally, first, so a later failure in backup or
/// persistence left `audio_dest` holding the NEW audio while the persisted
/// transcript still described the OLD one — permanently desynced, since the
/// old transcript's segment timestamps refer to audio that no longer exists
/// on disk. The one residual edge case this does not cover: a failure of the
/// final promote-rename itself, after backup and persistence have both
/// already succeeded, would leave `audio_dest` OLD while the persisted
/// transcript is already the NEW one — an same-directory `rename` failing
/// after both prior steps succeeded is not exercised by any test here and is
/// not otherwise guarded against.
///
/// `staged` is not cleaned up on error here — the caller
/// ([`run_retranscribe`]) does that in its own `Err` branch, mirroring every
/// other tmp file in this module.
pub fn promote_and_persist_retranscribe(
    store: &FsMeetingStore,
    staged: &Path,
    audio_dest: &Path,
    previous_transcript: Option<(&Transcript, &BTreeMap<String, String>)>,
    updated: &Meeting,
) -> Result<(), AppError> {
    if let Some((transcript, speaker_names)) = previous_transcript {
        let meeting_dir = audio_dest
            .parent()
            .ok_or_else(|| AppError::Path("audio path has no parent directory".to_string()))?;
        ingest::backup_transcript(meeting_dir, transcript, speaker_names)?;
    }

    store.save(updated)?;

    fs::rename(staged, audio_dest)?;

    Ok(())
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
    guard_import_vs_summary(state.summary_busy())?;
    let _guard = state.import_guard()?;

    run_diarize(app, &state, id)
}

/// RAII end-of-operation release for the cached speaker diarizer,
/// mirroring `commands::summary`'s summarizer release guard and
/// [`AppState::import_guard`]'s shape for the busy flag: `Drop` calls
/// [`AppState::release_diarizer`], so the diarizer's ONNX models are dropped
/// on every exit path — `Ok`, `Err`, *and* a panic unwind — instead of only
/// on a returned outcome.
///
/// Unwind ordering is what makes this correct, not just best-effort: the
/// guard lives in [`run_diarize`]'s frame while the operation's own model
/// `Arc` lives inside [`diarize_and_relabel`]'s scope, so a panic drops the
/// operation `Arc` first during inner-frame unwinding and the guard's `Drop`
/// then observes the slot as the sole holder — exactly the `release_if_last`
/// condition. The import guard held by [`diarize_meeting_blocking`]
/// guarantees no concurrent holder. Cross-guard `Busy` semantics are
/// unchanged: this releases only the model slot, never the busy flag.
struct DiarizerReleaseGuard<'a> {
    state: &'a AppState,
}

impl Drop for DiarizerReleaseGuard<'_> {
    fn drop(&mut self) {
        self.state.release_diarizer();
    }
}

/// Does the actual work of [`diarize_meeting`], factored out so the caller
/// can hold [`AppState::import_guard`] across the whole call — that guard's
/// `Drop` releases the busy flag regardless of outcome, including a panic
/// partway through this function — mirrors [`run_retranscribe`].
///
/// End-of-operation model release (mirrors `commands::summary`'s
/// summarizer release): [`DiarizerReleaseGuard`] (held for this whole call)
/// drops the diarizer's ONNX models via [`AppState::release_diarizer`] once
/// this function's own `Arc` is gone and the import guard guarantees no
/// concurrent holder, so the next diarization pays a seconds-scale reload
/// instead of the models leaking for the app's whole lifetime.
fn run_diarize(
    app: &AppHandle,
    state: &State<'_, AppState>,
    id: MeetingId,
) -> Result<MeetingDto, AppError> {
    let app_state: &AppState = state;
    let _release = DiarizerReleaseGuard { state: app_state };
    diarize_and_relabel(app, state, id)
}

fn diarize_and_relabel(
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
    // SAFETY-REVERT: extra full-file STT pass disabled — full-file
    // single-shot decode (`accept_waveform` + decode) while the diarizer Arc
    // is held caused a native OOM abort (dual residency). Detect speakers
    // returns to diar-only behavior (stage-1 labels only); stage 2 reduces
    // to its text-preserving no-op via the empty vec below.
    let words: Vec<Word> = Vec::new();
    let relabeled = apply_diarize_result(&transcript, diarize_result, &words)?;
    // Phase-3 judge gate (`MYNA_DIARIZE_JUDGE=1`, default OFF): flag off
    // returns the Phase-1+2 output as today; flag on attempts the judge
    // path but fails soft — no LLM call is wired in this step, so an
    // enabled flag logs and returns the Phase-2 output unchanged (text
    // lock re-verified below before save).
    let judged = apply_judge_fallback(&relabeled, is_judge_enabled());
    verify_transcripts_text_locked(&transcript, &judged)?;

    let updated = meeting.with_transcript(judged);
    state.store.save(&updated)?;

    Ok(MeetingDto::from_meeting(
        updated,
        ingest::has_audio(&audio_dest),
        true,
    ))
}

/// Fail-soft judge seam behind `MYNA_DIARIZE_JUDGE=1` (default OFF).
/// Flag off returns `phase2` unchanged (today's behavior); flag on attempts
/// the judge path but — with no LLM call wired in this step — logs and
/// returns the Phase-2 output unchanged, so judge on/off have identical
/// `full_text`. Takes the flag as a `bool` (wired to
/// [`is_judge_enabled`] by [`diarize_and_relabel`]) so the parity contract
/// is unit-testable without mutating the process environment. Never creates
/// a second engine and never blocks the manual trigger.
fn apply_judge_fallback(phase2: &Transcript, judge_enabled: bool) -> Transcript {
    if !judge_enabled {
        return phase2.clone();
    }
    eprintln!(
        "myna-app: diarize judge enabled but LLM judge path not wired; returning Phase-2 output"
    );
    phase2.clone()
}

/// Minimum decodable system-track duration, in seconds. Anything shorter
/// (header-only, empty, or a sub-word blip) would hand an empty or
/// near-empty buffer to the diarizer FFI — reject it here with a clean
/// user-readable error instead.
const MIN_SYSTEM_TRACK_SEC: f64 = 0.5;

/// Pure guard: `Err(NotFound)` when `system_track` doesn't exist on disk —
/// diarization has nothing to analyze (a mic-only recording, or a legacy/
/// imported meeting with no track separation). Also rejects degenerate
/// tracks (unreadable header, zero frames, zero-width frames, < 0.5 s) via
/// [`guard_system_track_decodable`] so a corrupt/truncated `track-system.wav`
/// never reaches `Diarizer::process` / `accept_waveform`. Extracted so these
/// rejections are unit-testable without a loaded [`myna_stt::Diarizer`] or
/// `AppHandle`.
fn guard_system_track_present(system_track: &Path) -> Result<(), AppError> {
    if !system_track.is_file() {
        return Err(AppError::NotFound(
            "no system audio was captured for this meeting".to_string(),
        ));
    }
    guard_system_track_decodable(system_track)
}

/// Header-only validation for the system track: opens the WAV header via
/// [`WavBlockReader`] (never decodes samples) and rejects zero-length or
/// too-short tracks before any sherpa FFI call.
///
/// Deliberately header-only rather than [`read_wav_to_f32`]: full decode
/// would load the whole track just to reject it, and integer-PCM
/// normalization shifts by `bits_per_sample - 1`, which underflows when a
/// corrupt header declares `bits_per_sample == 0`. Checking
/// `bytes_per_frame() == 0` first rejects that shape here without ever
/// reaching the shift.
fn guard_system_track_decodable(system_track: &Path) -> Result<(), AppError> {
    let reader = WavBlockReader::open(system_track).map_err(|err| {
        AppError::NotFound(format!(
            "no system audio was captured for this meeting ({err})"
        ))
    })?;
    if reader.bytes_per_frame() == 0 {
        return Err(AppError::NotFound(
            "no system audio was captured for this meeting (unreadable WAV header)".to_string(),
        ));
    }
    let bytes_per_frame = reader.bytes_per_frame();
    let total_frames = reader.total_frames();
    if total_frames == 0 {
        return Err(AppError::NotFound(
            "no system audio was captured for this meeting (empty track)".to_string(),
        ));
    }
    // Truncation clamp: `total_frames` comes from the header's declared
    // data-chunk length, which survives truncating the file's bytes (e.g. a
    // 44-byte header-only slice still declares the full frame count). Bound
    // it against the file's actual size so a truncated track can't pass the
    // duration floor on declared-but-absent frames.
    let file_len = std::fs::metadata(system_track)
        .map(|m| m.len())
        .unwrap_or(0);
    let frames_by_size = file_len.saturating_sub(44) / bytes_per_frame;
    if frames_by_size == 0 {
        return Err(AppError::NotFound(
            "no system audio was captured for this meeting (empty track)".to_string(),
        ));
    }
    let effective_frames = total_frames.min(frames_by_size);
    let sample_rate = reader.sample_rate();
    if sample_rate == 0 {
        return Err(AppError::NotFound(
            "no system audio was captured for this meeting (unreadable WAV header)".to_string(),
        ));
    }
    let duration_sec = effective_frames as f64 / f64::from(sample_rate);
    if duration_sec < MIN_SYSTEM_TRACK_SEC {
        return Err(AppError::NotFound(format!(
            "system audio too short to diarize ({duration_sec:.2}s; need at least {MIN_SYSTEM_TRACK_SEC:.1}s)"
        )));
    }
    Ok(())
}

/// Fail-soft word-timing decode feeding [`apply_diarize_result`]'s stage-2
/// word-vote fallback: reads `system_track` (`track-system.wav`) to mono
/// `f32` and re-decodes it with the shared [`SttEngine`] via
/// [`SttEngine::transcribe_samples_words`], returning track-start-relative
/// [`Word`] timings for [`align_words_to_diar`].
///
/// Local re-decode — not plumbing through
/// [`ingest::transcribe_tracks_streaming`] /
/// [`ingest::transcribe_wav_streaming`] — is the deliberate minimal choice:
/// those functions' `(Transcript, f32)` return shape is pinned by every
/// ingest caller and test, and transcribe-time words wouldn't survive anyway
/// (see the call-site comment in [`diarize_and_relabel`]). Re-decoding here
/// reuses the already-loaded engine `Arc` (never a second loaded engine,
/// which would double RAM) at the cost of one extra full-file STT pass over
/// the system track; diarization never runs automatically, so that cost is
/// only ever paid on explicit user request.
///
/// Fail-soft: any failure (engine load, WAV read, decode) logs and returns
/// an empty vec, reducing stage 2 to its text-preserving no-op — a meeting
/// whose words can't be decoded still gets its stage-1 relabeling. On a
/// successful decode restarts the engine's idle-TTL countdown (see
/// [`AppState::touch_stt_last_used`]) since the engine was genuinely used.
#[allow(dead_code)]
fn decode_system_track_words(
    state: &State<'_, AppState>,
    app: &AppHandle,
    system_track: &Path,
) -> Vec<Word> {
    let engine = match state.stt_engine(app) {
        Ok(engine) => engine,
        Err(err) => {
            eprintln!(
                "myna-app: diarize word-vote fallback skipped (STT engine unavailable: {err})"
            );
            return Vec::new();
        }
    };
    let (samples, sample_rate) = match read_wav_to_f32(system_track) {
        Ok(pair) => pair,
        Err(err) => {
            eprintln!(
                "myna-app: diarize word-vote fallback skipped (system track unreadable: {err})"
            );
            return Vec::new();
        }
    };
    match engine.transcribe_samples_words(sample_rate as i32, &samples) {
        Ok(words) => {
            state.touch_stt_last_used();
            words
        }
        Err(err) => {
            eprintln!("myna-app: diarize word-vote fallback skipped (word decode failed: {err})");
            Vec::new()
        }
    }
}

/// Applies a [`DiarizeResult`] to `transcript` via
/// [`relabel_others_with_config`], propagating `diarize_result`'s error
/// untouched when diarization itself failed rather than ever returning a
/// partial or empty transcript. This is the single seam [`run_diarize`] calls
/// [`crate::store::MeetingStore::save`] through, so it structurally
/// guarantees the fail-soft contract documented on [`diarize_meeting`]:
/// extracted so that contract is unit-testable with a synthetic `Err`,
/// without a loaded [`myna_stt::Diarizer`].
fn apply_diarize_result(
    transcript: &Transcript,
    diarize_result: Result<DiarizeResult, SttError>,
    words: &[Word],
) -> Result<Transcript, AppError> {
    let result = diarize_result?;
    // Exclude→merge→smooth→compact→relabel pipeline (manual-trigger
    // diarization only): drop sub-word blips, join same-speaker turns across
    // short gaps, collapse single-segment flicker by majority vote, remap the
    // surviving (sparse) cluster ids to dense `0..K`, then relabel.
    // Recall-tuned defaults from `DiarizeConfig::default()`: 0.75 s
    // `min_segment_sec` (short confirmations relabel), 0.60 `min_coverage`
    // (split-coverage turns recover), 1.0 s `smooth_window_sec` + 0.8 s
    // `merge_gap_sec` (same-speaker over-segmentation joins via merge+smooth).
    // `threshold` 0.5 and `min_duration_on` 0.3 / `min_duration_off` 0.5 stay
    // on the embedding side pending a measured sweep. Abstain-to-bare still
    // guarantees no text rewrite — the text lock below is unchanged.
    let cfg = DiarizeConfig::default();
    let filtered = exclude_short_segments(&result.segments, cfg.min_diar_segment_sec);
    let merged = post_merge(
        &DiarizeResult {
            num_speakers: result.num_speakers,
            segments: filtered,
        },
        cfg.merge_gap_sec,
    );
    let smoothed = smooth_labels(&merged.segments, cfg.smooth_window_sec);
    // Smoothing can out-vote a whole cluster, so compact *after* it: the
    // labels below must be dense `others:1..=K` over the clusters that
    // actually survive the chain, never a raw id like `others:171`.
    let compacted = compact_speaker_indices(&DiarizeResult {
        num_speakers: merged.num_speakers,
        segments: smoothed,
    });
    let processed = DiarizeResult {
        // The diarizer's reported count drives the `num_speakers < 2` gate
        // in `relabel_others_with_config`: filtering may drop a minority
        // speaker's only evidence (see
        // `apply_diarize_result_preserves_speaker_count_through_minority_filtering`)
        // without making the recording single-speaker. The compacted
        // survivor count `K` is never larger, so every `speaker_index` stays
        // `< num_speakers`.
        num_speakers: result.num_speakers.max(compacted.num_speakers),
        segments: compacted.segments,
    };
    let relabeled = relabel_others_with_config(transcript, &processed, &cfg);
    // Stage 2: word-majority vote fallback for segments still bare
    // `others` after the span-coverage rule above. This recovers turns at or
    // above `min_segment_sec` whose *time* coverage splits across speakers
    // (stage 1 abstains below `min_coverage`) but whose *words* concentrate
    // on one speaker — the vote comes from `words`, the system track's
    // re-decoded timings (see `decode_system_track_words`), aligned to the
    // processed diarization via `align_words_to_diar`. Sub-`min_segment_sec`
    // turns still abstain even when unanimous: `relabel_others_word_level`
    // enforces the same duration floor as stage 1, so truly short exchanges
    // stay bare `others` by design (see
    // `apply_diarize_result_short_exchange_stays_bare_with_text_locked`).
    // Empty `words` (decode unavailable) keeps this stage a
    // text-preserving no-op via `apply_word_vote_fallback`.
    let aligned: Vec<(Word, Option<u32>)> = if words.is_empty() {
        Vec::new()
    } else {
        align_words_to_diar(words, &processed.segments)
    };
    let fallback = apply_word_vote_fallback(&relabeled, &processed, &cfg, &aligned);
    // Fail-closed text lock: relabeling must only ever rewrite `speaker`
    // labels, never segment text. Compared pairwise per segment with no
    // `full_text()` allocation (and strictly stronger than joined-string
    // equality, which masks boundary shifts like "ab"+"c" vs "a"+"bc") —
    // on mismatch this returns `Err`, and `run_diarize` only calls
    // `MeetingStore::save` with this function's `Ok` value, so a corrupted
    // relabel structurally never reaches the store.
    verify_transcripts_text_locked(transcript, &fallback)?;
    Ok(fallback)
}

/// Stage-2 word-vote fallback for [`apply_diarize_result`]: relabels
/// segments still bare `others` after stage 1's span-coverage pass via
/// [`relabel_others_word_level`] with the same `cfg`.
///
/// `aligned` is the output of `align_words_to_diar` over the transcript's
/// word timings. When it is empty (word timings unavailable — the offline
/// path's state today), this skips the vote, logs, and returns `stage1`
/// unchanged so the text lock in `apply_diarize_result` trivially holds.
/// Never touches `me` / `unknown` / pinned / user-minted `others:mN`: that
/// guarantee is inherited from `relabel_others_word_level`'s candidate gate
/// (bare `others` plus stale pure-numeric `others:N` only).
fn apply_word_vote_fallback(
    stage1: &Transcript,
    processed: &DiarizeResult,
    cfg: &DiarizeConfig,
    aligned: &[(Word, Option<u32>)],
) -> Transcript {
    if aligned.is_empty() {
        eprintln!("myna-app: diarize word-vote fallback skipped (no word timings available)");
        return stage1.clone();
    }
    relabel_others_word_level(stage1, processed, aligned, cfg)
}

/// Pure fail-closed guard for [`apply_diarize_result`]'s text lock:
/// `Ok(())` when relabeling left every segment's text byte-identical,
/// `Err(Store)` otherwise. Extracted so the mismatch arm is unit-testable
/// without a transcript at all — the happy path (equality) is pinned by
/// `apply_diarize_result_*_preserves_full_text` below.
///
/// Kept alongside [`verify_transcripts_text_locked`] (the allocation-free
/// path production verifies use): this `&str` form is the unit-test seam
/// for the mismatch arm.
// `dead_code` is expected in non-test builds: production verifies whole
// transcripts via `verify_transcripts_text_locked`; only tests call this.
#[allow(dead_code)]
fn verify_full_text_locked(before: &str, after: &str) -> Result<(), AppError> {
    if before == after {
        Ok(())
    } else {
        Err(AppError::Store(
            "diarization relabeling altered transcript text; refusing to save".to_string(),
        ))
    }
}

/// Allocation-free counterpart to [`verify_full_text_locked`] for whole
/// transcripts: `Ok(())` when `after` carries the same segments with
/// byte-identical text (speakers may differ — that is the relabeling), and
/// `Err(Store)` otherwise. Compares pairwise per segment instead of
/// building two `full_text()` strings, so the diarize verify path performs
/// zero text clones; strictly stronger than joined-string equality, which
/// cannot see text move across a segment boundary.
fn verify_transcripts_text_locked(before: &Transcript, after: &Transcript) -> Result<(), AppError> {
    let texts_match = before.segments.len() == after.segments.len()
        && before
            .segments
            .iter()
            .zip(after.segments.iter())
            .all(|(before_segment, after_segment)| before_segment.text == after_segment.text);
    if texts_match {
        Ok(())
    } else {
        Err(AppError::Store(
            "diarization relabeling altered transcript text; refusing to save".to_string(),
        ))
    }
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
        // Arrange: a valid 1 s mono tone — long enough to clear the 0.5 s
        // degenerate-track floor.
        let dir = tempfile::tempdir().expect("tempdir");
        let track = dir.path().join("track-system.wav");
        write_tone_wav(&track, 16_000, 16_000);

        // Act / Assert
        assert!(guard_system_track_present(&track).is_ok());
    }

    fn write_tone_wav(path: &Path, sample_rate: u32, frames: usize) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("create wav");
        for i in 0..frames {
            let sample = ((i as f32 * 0.05).sin() * 10_000.0) as i16;
            writer.write_sample(sample).expect("write sample");
        }
        writer.finalize().expect("finalize wav");
    }

    #[test]
    fn guard_system_track_present_rejects_an_empty_file() {
        // Arrange: 0-byte file — header unreadable.
        let dir = tempfile::tempdir().expect("tempdir");
        let track = dir.path().join("track-system.wav");
        std::fs::write(&track, b"").expect("write fixture");

        // Act
        let err = guard_system_track_present(&track).expect_err("0-byte must be Err");

        // Assert: clean NotFound, never a panic, message is user-readable.
        assert!(matches!(err, AppError::NotFound(_)), "got: {err:?}");
        assert!(err.to_string().to_lowercase().contains("system audio"));
    }

    #[test]
    fn guard_system_track_present_rejects_a_header_only_file() {
        // Arrange: 44-byte header declaring zero frames.
        let dir = tempfile::tempdir().expect("tempdir");
        let track = dir.path().join("track-system.wav");
        let header_only = dir.path().join("header-only.wav");
        write_tone_wav(&header_only, 16_000, 16_000);
        let bytes = std::fs::read(&header_only).expect("read fixture");
        assert!(bytes.len() > 44, "fixture must have data beyond the header");
        std::fs::write(&track, &bytes[..44]).expect("write header-only fixture");

        // Act
        let err = guard_system_track_present(&track).expect_err("header-only must be Err");

        // Assert
        assert!(matches!(err, AppError::NotFound(_)), "got: {err:?}");
        assert!(err.to_string().to_lowercase().contains("system audio"));
    }

    #[test]
    fn guard_system_track_present_rejects_a_too_short_tone() {
        // Arrange: 0.2 s tone — decodable but below the 0.5 s floor.
        let dir = tempfile::tempdir().expect("tempdir");
        let track = dir.path().join("track-system.wav");
        write_tone_wav(&track, 16_000, 3_200);

        // Act
        let err = guard_system_track_present(&track).expect_err("0.2s must be Err");

        // Assert: clean reject mentioning too short, never reaching FFI.
        assert!(matches!(err, AppError::NotFound(_)), "got: {err:?}");
        assert!(
            err.to_string().to_lowercase().contains("too short"),
            "message should say too short, got: {err}"
        );
    }

    #[test]
    fn guard_system_track_decodable_rejects_garbage_bytes() {
        // Arrange: non-WAV bytes with file length > 0.
        let dir = tempfile::tempdir().expect("tempdir");
        let track = dir.path().join("track-system.wav");
        std::fs::write(&track, b"not a wav file at all, just text").expect("write fixture");

        // Act
        let err = guard_system_track_present(&track).expect_err("garbage must be Err");

        // Assert
        assert!(matches!(err, AppError::NotFound(_)), "got: {err:?}");
        assert!(err.to_string().to_lowercase().contains("system audio"));
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
                suspect_reasons: Vec::new(),
                original_text: None,
                edited: false,
            }],
        };

        // Act: diarization itself failed (e.g. model load failure).
        let result = apply_diarize_result(&transcript, Err(SttError::DiarizeInit), &[]);

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
                suspect_reasons: Vec::new(),
                original_text: None,
                edited: false,
            }],
        };
        let diarize_result = DiarizeResult {
            num_speakers: 2,
            segments: vec![
                myna_stt::DiarizeSegment {
                    start_sec: 0.0,
                    end_sec: 4.5,
                    speaker_index: 0,
                },
                myna_stt::DiarizeSegment {
                    start_sec: 4.5,
                    end_sec: 5.0,
                    speaker_index: 1,
                },
            ],
        };

        // Act
        let relabeled =
            apply_diarize_result(&transcript, Ok(diarize_result), &[]).expect("should succeed");

        // Assert: the confident single-speaker segment picked up a
        // per-speaker label instead of staying bare `others`.
        assert_ne!(relabeled.segments[0].speaker.as_str(), "others");
    }

    // --- apply_diarize_result: fail-closed full_text lock ------------------

    #[test]
    fn apply_diarize_result_preserves_full_text_on_success() {
        // Arrange: a successful relabel must leave every segment's text
        // byte-identical, so the text lock inside `apply_diarize_result`
        // passes and the relabeled transcript is returned.
        let transcript = Transcript {
            segments: vec![TranscriptSegment {
                start_sec: 0.0,
                end_sec: 5.0,
                text: "quarterly results look good".to_string(),
                speaker: Speaker::others(),
                speaker_pinned: false,
                suspect_reasons: Vec::new(),
                original_text: None,
                edited: false,
            }],
        };
        let before = transcript.full_text();
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
            apply_diarize_result(&transcript, Ok(diarize_result), &[]).expect("should succeed");

        // Assert: labels may change, text must not.
        assert_eq!(relabeled.full_text(), before);
    }

    #[test]
    fn verify_full_text_locked_rejects_a_text_mismatch_without_saving() {
        // Arrange: a relabel step that corrupted segment text (simulated
        // here by comparing two different strings directly against the
        // lock helper — `apply_diarize_result` itself can never produce
        // this, which is exactly the invariant under test).

        // Act
        let err =
            verify_full_text_locked("quarterly results look good", "quarterly results look bad")
                .expect_err("text mismatch must fail closed");

        // Assert: the error surfaces as `Store`, and — since `run_diarize`
        // only calls `MeetingStore::save` with `apply_diarize_result`'s
        // `Ok` value — this failure structurally never reaches the store,
        // leaving the meeting's on-disk transcript exactly as it was.
        assert!(
            matches!(err, AppError::Store(_)),
            "expected a Store error that blocks the save, got: {err:?}"
        );
        assert!(
            verify_full_text_locked("identical text", "identical text").is_ok(),
            "identical text must pass the lock"
        );
    }

    #[test]
    fn apply_diarize_result_preserves_speaker_count_through_minority_filtering() {
        // Arrange: diarizer reported 2 speakers, but the minority speaker's
        // only evidence is a 0.1 s blip that `exclude_short_segments`
        // (min_diar 0.25 s) drops. The majority turn still covers the
        // transcript segment, so relabeling must proceed — the recomputed
        // distinct count (2→1) must not trip the `num_speakers < 2` gate.
        let transcript = Transcript {
            segments: vec![TranscriptSegment {
                start_sec: 0.0,
                end_sec: 5.0,
                text: "quarterly results look good".to_string(),
                speaker: Speaker::others(),
                speaker_pinned: false,
                suspect_reasons: Vec::new(),
                original_text: None,
                edited: false,
            }],
        };
        let diarize_result = DiarizeResult {
            num_speakers: 2,
            segments: vec![
                myna_stt::DiarizeSegment {
                    start_sec: 0.0,
                    end_sec: 5.0,
                    speaker_index: 0,
                },
                myna_stt::DiarizeSegment {
                    start_sec: 5.1,
                    end_sec: 5.2,
                    speaker_index: 1,
                },
            ],
        };

        // Act
        let relabeled =
            apply_diarize_result(&transcript, Ok(diarize_result), &[]).expect("should succeed");

        // Assert: majority turn relabeled despite minority evidence being
        // filtered; text untouched.
        assert_eq!(relabeled.segments[0].speaker.as_str(), "others:1");
        assert_eq!(
            relabeled.full_text(),
            transcript.full_text(),
            "relabel must only rewrite speaker labels"
        );
    }

    // --- apply_diarize_result: speaker-index compaction ---------------------
    //
    // sherpa-onnx's `NumSpeakers()` is a *distinct* count of surviving
    // clusters, but each `speaker_index` is the raw cluster column id in
    // `0..=max_cluster_index`. Sub-`min_duration_on` clusters vanish, so the
    // surviving ids are sparse (a real meeting emitted `1,2,3,5,...,170,171`).
    // Labels shown to the user must be dense `others:1..=K` where `K` is the
    // number of clusters that actually survive the post-processing chain.

    /// Parses the numeric sub-id of an `others:N` label; `None` for bare
    /// `others`, `me`, `unknown`, or user-minted `others:mN`.
    fn others_numeric_id(speaker: &Speaker) -> Option<u32> {
        speaker
            .as_str()
            .strip_prefix("others:")
            .and_then(|id| id.parse::<u32>().ok())
    }

    #[test]
    fn apply_diarize_result_compacts_sparse_speaker_indices_to_dense_labels() {
        // Arrange: two confident bare `others` turns, attributed to raw
        // cluster ids `0` and `170` — the diarizer reports 2 speakers, and
        // exactly 2 clusters survive, so the only valid labels are
        // `others:1` and `others:2`.
        let transcript = Transcript {
            segments: vec![
                TranscriptSegment {
                    start_sec: 0.0,
                    end_sec: 5.0,
                    text: "first speaker point".to_string(),
                    speaker: Speaker::others(),
                    speaker_pinned: false,
                    suspect_reasons: Vec::new(),
                    original_text: None,
                    edited: false,
                },
                TranscriptSegment {
                    start_sec: 5.0,
                    end_sec: 10.0,
                    text: "second speaker rebuttal".to_string(),
                    speaker: Speaker::others(),
                    speaker_pinned: false,
                    suspect_reasons: Vec::new(),
                    original_text: None,
                    edited: false,
                },
            ],
        };
        let diarize_result = DiarizeResult {
            num_speakers: 2,
            segments: vec![
                myna_stt::DiarizeSegment {
                    start_sec: 0.0,
                    end_sec: 5.0,
                    speaker_index: 0,
                },
                myna_stt::DiarizeSegment {
                    start_sec: 5.0,
                    end_sec: 10.0,
                    speaker_index: 170,
                },
            ],
        };

        // Act
        let relabeled =
            apply_diarize_result(&transcript, Ok(diarize_result), &[]).expect("should succeed");

        // Assert: dense 1-based labels in order of first appearance, and no
        // label may exceed the surviving speaker count.
        assert_eq!(relabeled.segments[0].speaker, Speaker::others_id("1"));
        assert_eq!(relabeled.segments[1].speaker, Speaker::others_id("2"));
        for segment in &relabeled.segments {
            if let Some(id) = others_numeric_id(&segment.speaker) {
                assert!(
                    id <= 2,
                    "label {} exceeds the 2 surviving speakers",
                    segment.speaker.as_str()
                );
            }
        }
    }

    #[test]
    fn apply_diarize_result_resets_stale_unpinned_others_labels() {
        // Arrange: a previous "Detect speakers" run left `others:7` on an
        // *unpinned* segment. Diarization indices are only stable within one
        // call, so a stale `others:N` from run A must be re-derived from run
        // B's result — otherwise two index namespaces mix in one transcript.
        let transcript = Transcript {
            segments: vec![TranscriptSegment {
                start_sec: 0.0,
                end_sec: 5.0,
                text: "quarterly results look good".to_string(),
                speaker: Speaker::others_id("7"),
                speaker_pinned: false,
                suspect_reasons: Vec::new(),
                original_text: None,
                edited: false,
            }],
        };
        let before = transcript.full_text();
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
            apply_diarize_result(&transcript, Ok(diarize_result), &[]).expect("should succeed");

        // Assert: the stale label is replaced by this run's dense label.
        assert_eq!(relabeled.segments[0].speaker, Speaker::others_id("1"));
        assert_eq!(relabeled.full_text(), before);
    }

    #[test]
    fn apply_diarize_result_emits_dense_labels_when_smoothing_eliminates_a_cluster() {
        // Arrange: three raw clusters `0`, `1`, `2`. Cluster `1` is a 0.3 s
        // flicker that survives `exclude_short_segments` (0.25 s floor) but
        // is out-voted by `smooth_labels` (1.0 s window: 0.3 s of self-votes
        // against 0.35 s from each neighbour), so only clusters `0` and `2`
        // survive the chain. Today's `num_speakers = result.max(merged)`
        // still reports 3, and the raw id `2` leaks out as `others:3` for a
        // transcript that only has 2 distinct speakers. The invariant under
        // guard: every emitted `others:N` satisfies `N <= K` where `K` is
        // the number of distinct `others:N` labels actually emitted (i.e.
        // the post-processed result's indices are dense `0..num_speakers`).
        let transcript = Transcript {
            segments: vec![
                TranscriptSegment {
                    start_sec: 0.0,
                    end_sec: 5.0,
                    text: "first speaker point".to_string(),
                    speaker: Speaker::others(),
                    speaker_pinned: false,
                    suspect_reasons: Vec::new(),
                    original_text: None,
                    edited: false,
                },
                TranscriptSegment {
                    start_sec: 5.0,
                    end_sec: 10.0,
                    text: "second speaker rebuttal".to_string(),
                    speaker: Speaker::others(),
                    speaker_pinned: false,
                    suspect_reasons: Vec::new(),
                    original_text: None,
                    edited: false,
                },
            ],
        };
        let diarize_result = DiarizeResult {
            num_speakers: 3,
            segments: vec![
                myna_stt::DiarizeSegment {
                    start_sec: 0.0,
                    end_sec: 5.0,
                    speaker_index: 0,
                },
                myna_stt::DiarizeSegment {
                    start_sec: 5.0,
                    end_sec: 5.3,
                    speaker_index: 1,
                },
                myna_stt::DiarizeSegment {
                    start_sec: 5.3,
                    end_sec: 10.0,
                    speaker_index: 2,
                },
            ],
        };

        // Act
        let relabeled =
            apply_diarize_result(&transcript, Ok(diarize_result), &[]).expect("should succeed");

        // Assert: both turns are labelled, and the label set is dense.
        let mut ids: Vec<u32> = relabeled
            .segments
            .iter()
            .filter_map(|segment| others_numeric_id(&segment.speaker))
            .collect();
        assert_eq!(
            ids.len(),
            relabeled.segments.len(),
            "both confident turns must be labelled, got {:?}",
            relabeled
                .segments
                .iter()
                .map(|segment| segment.speaker.as_str().to_string())
                .collect::<Vec<_>>()
        );
        ids.sort_unstable();
        ids.dedup();
        let surviving = ids.len() as u32;
        let expected: Vec<u32> = (1..=surviving).collect();
        assert_eq!(
            ids, expected,
            "emitted others:N labels must be dense 1..={surviving} (speaker_index < num_speakers)"
        );
    }

    #[test]
    fn judge_fallback_keeps_phase2_text_identical_on_and_off() {
        // Arrange: a Phase-2 relabeled transcript (LLM unavailable, so the
        // judge path must fall back to exactly this).
        let phase2 = Transcript {
            segments: vec![TranscriptSegment {
                start_sec: 0.0,
                end_sec: 5.0,
                text: "quarterly results look good".to_string(),
                speaker: Speaker::others_id("1"),
                speaker_pinned: false,
                suspect_reasons: Vec::new(),
                original_text: None,
                edited: false,
            }],
        };

        // Act: flag off (today's path) vs flag on (fail-soft fallback).
        let off = apply_judge_fallback(&phase2, false);
        let on = apply_judge_fallback(&phase2, true);

        // Assert: both are text-identical to Phase-2 output.
        assert_eq!(off.full_text(), phase2.full_text());
        assert_eq!(on.full_text(), phase2.full_text());
        assert_eq!(off, phase2);
        assert_eq!(on, phase2);
    }

    #[test]
    fn apply_diarize_result_short_exchange_stays_bare_with_text_locked() {
        // Arrange: a sub-0.75 s bare `others` turn with unanimous
        // diarization coverage — stage 1 abstains on `min_segment_sec`
        // (default 0.75 s), and stage 2 has no word timings plumbed yet
        // (empty `aligned`), so it must also abstain rather than panic
        // or edit text.
        let transcript = Transcript {
            segments: vec![TranscriptSegment {
                start_sec: 0.0,
                end_sec: 0.6,
                text: "yes".to_string(),
                speaker: Speaker::others(),
                speaker_pinned: false,
                suspect_reasons: Vec::new(),
                original_text: None,
                edited: false,
            }],
        };
        let before = transcript.full_text();
        let diarize_result = DiarizeResult {
            num_speakers: 2,
            segments: vec![myna_stt::DiarizeSegment {
                start_sec: 0.0,
                end_sec: 0.6,
                speaker_index: 0,
            }],
        };

        // Act (must not panic)
        let relabeled =
            apply_diarize_result(&transcript, Ok(diarize_result), &[]).expect("should succeed");

        // Assert: stays bare `others` (word-vote fallback either labels
        // it once timings land, or leaves it bare) with text unchanged.
        assert_eq!(
            relabeled.segments[0].speaker,
            Speaker::others(),
            "short turn must not be fabricated without word timings"
        );
        assert_eq!(relabeled.full_text(), before);
    }

    #[test]
    fn apply_diarize_result_word_vote_labels_split_coverage_exchange_with_text_locked() {
        // Arrange: a short two-speaker exchange (2 s turns, just above the
        // 0.75 s `min_segment_sec` floor) where stage 1's span-coverage rule
        // abstains on each turn — diarization splits each turn 50/50 across
        // speakers, below the 0.60 `min_coverage` — but the re-decoded word
        // timings vote 3-to-1 per turn, so the stage-2 word-vote fallback
        // labels each turn. Synthetic `Word`s stand in for
        // `decode_system_track_words` output here so this stays a pure unit
        // test without a loaded `SttEngine`; the alignment itself
        // (`align_words_to_diar` over the *processed*, post-merge diar
        // segments) runs for real inside `apply_diarize_result`.
        let transcript = Transcript {
            segments: vec![
                TranscriptSegment {
                    start_sec: 0.0,
                    end_sec: 2.0,
                    text: "hello there team".to_string(),
                    speaker: Speaker::others(),
                    speaker_pinned: false,
                    suspect_reasons: Vec::new(),
                    original_text: None,
                    edited: false,
                },
                TranscriptSegment {
                    start_sec: 2.0,
                    end_sec: 4.0,
                    text: "thanks so much".to_string(),
                    speaker: Speaker::others(),
                    speaker_pinned: false,
                    suspect_reasons: Vec::new(),
                    original_text: None,
                    edited: false,
                },
            ],
        };
        let before = transcript.full_text();
        let diarize_result = DiarizeResult {
            num_speakers: 2,
            segments: vec![
                myna_stt::DiarizeSegment {
                    start_sec: 0.0,
                    end_sec: 1.0,
                    speaker_index: 0,
                },
                myna_stt::DiarizeSegment {
                    start_sec: 1.0,
                    end_sec: 2.0,
                    speaker_index: 1,
                },
                myna_stt::DiarizeSegment {
                    start_sec: 2.0,
                    end_sec: 3.0,
                    speaker_index: 1,
                },
                myna_stt::DiarizeSegment {
                    start_sec: 3.0,
                    end_sec: 4.0,
                    speaker_index: 0,
                },
            ],
        };
        // Midpoints cluster 3-to-1 per turn in the winning diar region
        // (post-merge the middle two diar segments join into one 1.0–3.0
        // speaker-1 turn, which the alignment below runs against).
        let words = vec![
            Word {
                text: "hello".to_string(),
                start_sec: 0.05,
                end_sec: 0.4,
            },
            Word {
                text: "there".to_string(),
                start_sec: 0.45,
                end_sec: 0.8,
            },
            Word {
                text: "team".to_string(),
                start_sec: 0.85,
                end_sec: 0.95,
            },
            Word {
                text: "yeah".to_string(),
                start_sec: 1.2,
                end_sec: 1.6,
            },
            Word {
                text: "thanks".to_string(),
                start_sec: 2.1,
                end_sec: 2.5,
            },
            Word {
                text: "so".to_string(),
                start_sec: 2.6,
                end_sec: 2.9,
            },
            Word {
                text: "much".to_string(),
                start_sec: 2.7,
                end_sec: 2.95,
            },
            Word {
                text: "right".to_string(),
                start_sec: 3.2,
                end_sec: 3.6,
            },
        ];

        // Act (must not panic; fails against the pre-fix empty-`aligned`
        // no-op, where both turns stay bare `others`).
        let relabeled =
            apply_diarize_result(&transcript, Ok(diarize_result), &words).expect("should succeed");

        // Assert: each turn takes the word-majority label; text untouched.
        assert_eq!(relabeled.segments[0].speaker, Speaker::others_id("1"));
        assert_eq!(relabeled.segments[1].speaker, Speaker::others_id("2"));
        assert_eq!(relabeled.full_text(), before);
    }

    #[test]
    fn word_vote_fallback_with_empty_alignment_is_a_text_preserving_noop() {
        // Arrange: a long bare `others` segment that stage 1 would label;
        // the fallback itself receives no word timings.
        let stage1 = Transcript {
            segments: vec![TranscriptSegment {
                start_sec: 0.0,
                end_sec: 5.0,
                text: "quarterly results look good".to_string(),
                speaker: Speaker::others_id("1"),
                speaker_pinned: false,
                suspect_reasons: Vec::new(),
                original_text: None,
                edited: false,
            }],
        };
        let processed = DiarizeResult {
            num_speakers: 2,
            segments: vec![myna_stt::DiarizeSegment {
                start_sec: 0.0,
                end_sec: 5.0,
                speaker_index: 0,
            }],
        };
        let cfg = DiarizeConfig::default();

        // Act
        let out = apply_word_vote_fallback(&stage1, &processed, &cfg, &[]);

        // Assert: no-op, text-identical — and `me`/`unknown`/pinned/
        // `others:N` are never touched by construction (empty input
        // returns stage1 verbatim).
        assert_eq!(out, stage1);
        assert_eq!(out.full_text(), stage1.full_text());
    }

    #[test]
    fn diarizer_release_guard_runs_on_unwind() {
        // Arrange: a fresh, idle `AppState` with an empty diarizer slot —
        // no model files needed, since the contract under test is that the
        // release path runs during unwinding, not the model load itself.
        use crate::store::folder_store::FsFolderStore;
        use crate::store::fs_store::FsMeetingStore;
        use std::panic::{self, AssertUnwindSafe};

        let dir = tempfile::tempdir().expect("tempdir");
        let state = AppState::new(
            FsMeetingStore::new(dir.path()),
            FsFolderStore::new(dir.path().to_path_buf()),
        );

        // Act: hold the release guard (mirroring `run_diarize`) and panic —
        // `catch_unwind` stands in for `spawn_blocking`'s own panic capture.
        let panic_result = panic::catch_unwind(AssertUnwindSafe(|| {
            let _release = DiarizerReleaseGuard { state: &state };
            panic!("simulated panic mid-diarization");
        }));
        assert!(
            panic_result.is_err(),
            "the simulated panic must actually unwind for this test to be meaningful"
        );

        // Assert: no model stays pinned — the slot is empty (as it was), and
        // the release ran without poisoning it. The full
        // loaded-model-dropped proof (`weak.upgrade().is_none()` on a warm
        // slot) needs ONNX model files, so it rests on the documented
        // unwind-ordering argument on `DiarizerReleaseGuard`: the operation
        // `Arc` drops in the inner frame first, the guard's `Drop` then sees
        // `release_if_last`'s sole-holder condition.
        assert!(
            state.diarizer_slot().weak().is_none(),
            "no diarizer model may stay pinned after a panic while the release guard was held"
        );
    }
}
