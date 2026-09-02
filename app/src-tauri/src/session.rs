//! Recording session state machine.
//!
//! [`RecordingSession`] owns two threads for one recording: a capture
//! worker that opens the (blocking) audio device and writes the WAV files,
//! and a decode worker that owns two [`SimulatedStreamer`]s — one per
//! [`Track`] — and turns buffered per-track audio into transcript events
//! stamped with the right speaker.
//!
//! This split matters because the audio callback cpal drives from
//! `capture_sources` runs on a real-time thread that must return in
//! roughly 20 ms. A full Parakeet decode measured 700 ms-p50 / 2.3 s-max
//! over live speech — running it inline in that callback (as this module
//! used to) starved the callback deadline so badly that over 97% of
//! captured audio was silently lost. [`DecodeChannel`] is the fix: a
//! bounded, non-blocking handoff from the callback to the decode worker
//! thread, so the callback's only job is writing the WAV files, computing
//! the level, and handing samples off — never waiting on a decode.
//!
//! Three WAV files are written per recording: `audio.wav` (device-native-rate
//! stereo, for listenable playback/export — its header is deferred until
//! `myna_audio::capture_sources`'s `on_native_rate` callback reports the
//! authoritative rate, since that can't be known synchronously ahead of
//! capture), and `track-mic.wav` / `track-system.wav` (16 kHz mono each, STT
//! grade, one per present [`Track`] — a track absent for the active capture
//! source never gets a file at all, so absence is distinguishable from
//! silence). All three live for the meeting's lifetime; none are deleted on
//! finalize.
//!
//! Two [`SimulatedStreamer`]s share one [`SttEngine`] (an `Arc`, never
//! duplicated — a second loaded engine would double RAM and change ORT
//! thread parallelism) and are driven from a single decode worker thread,
//! dispatching by [`Track`], so decode stays serialized exactly as it was
//! with one streamer.
//!
//! [`LevelThrottle`] is extracted as a pure, clock-driven helper so the
//! level-event throttling logic can be unit tested without a real audio
//! device.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use myna_audio::{
    capture_sources, mix_into, rms, rms_dbfs, CaptureConfig, CaptureRequest, CaptureSource,
    DeviceInfo, RecordingSpec, SystemAudioSource, SystemAudioStatus, TrackBlock, WavRecorder,
};
use myna_stt::{
    SimulatedStreamer, Speaker, SttEngine, SttEvent, Transcript, TranscriptSegment, VadConfig,
};

use crate::domain::MeetingId;
use crate::error::AppError;
use crate::events::{
    emit_recording_state, FinalPayload, LevelPayload, PartialPayload, RECORDING_LEVEL,
    TRANSCRIPT_FINAL, TRANSCRIPT_PARTIAL,
};
use crate::session_manifest::JournalWriter;

/// Minimum spacing between [`RECORDING_LEVEL`] emissions, in milliseconds.
pub const LEVEL_EMIT_INTERVAL_MS: u64 = 100;

/// Recording session lifecycle state, mirrored to the UI via
/// [`crate::events::RECORDING_STATE`].
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum RecordingState {
    Idle,
    Recording,
    Stopping,
}

/// Pure, testable throttle answering "has at least `interval_ms` elapsed
/// since the last emission?" — driven by caller-supplied `Instant`s so
/// tests don't depend on wall-clock timing or a real device.
pub struct LevelThrottle {
    interval_ms: u64,
    last_emit: Option<Instant>,
}

impl LevelThrottle {
    pub fn new(interval_ms: u64) -> Self {
        Self {
            interval_ms,
            last_emit: None,
        }
    }

    /// Returns `true` (and records `now` as the new last-emit instant) the
    /// first time it's called, and thereafter at most once per
    /// `interval_ms`.
    pub fn should_emit(&mut self, now: Instant) -> bool {
        let elapsed_enough = match self.last_emit {
            None => true,
            Some(last) => {
                now.saturating_duration_since(last).as_millis() as u64 >= self.interval_ms
            }
        };
        if elapsed_enough {
            self.last_emit = Some(now);
        }
        elapsed_enough
    }
}

/// Pure guard for starting a recording: `Busy` when one is already active,
/// or when an import/re-transcribe is currently in flight (which would put
/// STT-decode-heavy blocking work in direct CPU contention with the new
/// recording's decode worker).
///
/// Extracted from [`RecordingSession`] itself so the start/stop busy-check
/// transitions are unit-testable against a plain `bool` rather than a real,
/// device-backed session.
pub fn guard_start(has_active_session: bool, import_busy: bool) -> Result<(), AppError> {
    if has_active_session {
        Err(AppError::Busy("a recording is already in progress"))
    } else if import_busy {
        Err(AppError::Busy(
            "cannot start a recording while an import is in progress",
        ))
    } else {
        Ok(())
    }
}

/// Pure guard for stopping/canceling a recording: `Busy` when none is
/// active. See [`guard_start`] for why this is a free function.
pub fn guard_stop(has_active_session: bool) -> Result<(), AppError> {
    if has_active_session {
        Ok(())
    } else {
        Err(AppError::Busy("no recording is in progress"))
    }
}

/// Pure guard for mutating a stored meeting (archive, transcript edit):
/// `Busy` when `target` is the meeting the active session is currently
/// recording into.
pub fn guard_not_recording(active: Option<MeetingId>, target: MeetingId) -> Result<(), AppError> {
    if active == Some(target) {
        return Err(AppError::Busy(
            "cannot modify the meeting currently being recorded",
        ));
    }
    Ok(())
}

/// Pure decision: resolves the effective [`CaptureSource`] for a new
/// recording from what was `requested` and the current system-audio
/// availability.
///
/// `requested = None` resolves to `CaptureSource::Microphone`. A request
/// for `System` or `Mixed` is **attempted** whenever `system_audio` is
/// [`SystemAudioStatus::Available`] *or* [`SystemAudioStatus::Unknown`],
/// and falls back to `Microphone` only for a *definitive* non-available
/// status ([`SystemAudioStatus::PermissionDenied`] /
/// [`SystemAudioStatus::Unavailable`]).
///
/// `Unknown` is deliberately treated as "attempt it", not "fall back":
/// there is no public preflight for `kTCCServiceAudioCapture` on macOS (see
/// `myna_audio`'s macOS backend docs), so `Unknown` is the normal state
/// before any capture has run in this process. Falling back to microphone
/// on `Unknown` would mean the very first Mixed/System recording never
/// attempts a tap — and the OS permission prompt, which only ever appears
/// from an actual capture attempt, might never show at all. Attempting it
/// is safe now that a failed attach degrades to microphone-only rather
/// than aborting the recording (see `myna_audio::capture_sources`'
/// `Mixed`-source fallback).
///
/// Extracted as a free function, like [`guard_start`]/[`guard_stop`], so
/// the fallback logic is unit-testable without a device, a model, or an
/// `AppHandle`.
pub fn resolve_capture_source(
    requested: Option<CaptureSource>,
    system_audio: SystemAudioStatus,
) -> CaptureSource {
    match requested.unwrap_or_default() {
        CaptureSource::Microphone => CaptureSource::Microphone,
        source @ (CaptureSource::System | CaptureSource::Mixed) => match system_audio {
            SystemAudioStatus::Available | SystemAudioStatus::Unknown => source,
            SystemAudioStatus::PermissionDenied { .. } | SystemAudioStatus::Unavailable { .. } => {
                CaptureSource::Microphone
            }
        },
    }
}

/// Pure decision: resolves the effective system-audio source id for a new
/// recording, from what was `requested` and the sources currently known to
/// be `available` (as reported by `myna_audio::list_system_audio_sources`).
///
/// `requested = None` means "all system output" and resolves to `None`,
/// same meaning. A `requested` id that isn't present in `available` falls
/// back to all-output (`None`) rather than being passed through to a
/// capture that would silently fail to find it — the same "never error,
/// always fall back" policy [`resolve_capture_source`] applies at the
/// source level.
///
/// This is a best-effort, synchronous pre-check only: the macOS capture
/// backend still re-resolves whatever id it receives against a **live**
/// snapshot immediately before opening the stream, since an id valid here
/// can go stale (the application quit, or a new instance got a new pid) by
/// the time capture actually starts. This check only keeps an obviously
/// wrong id — a typo, or an application that already isn't running — from
/// ever reaching that point.
pub fn resolve_system_source_id(
    requested: Option<String>,
    available: &[SystemAudioSource],
) -> Option<String> {
    let requested = requested?;
    available
        .iter()
        .any(|source| source.id == requested)
        .then_some(requested)
}

/// Records the capture backend's resolved system-audio source into `slot`
/// (so `recording_state` polls and `stop`/`cancel` emissions report it) and
/// hands it to `emit` so the UI learns about it immediately.
///
/// `emit` receives `Some(resolved)` — never `None`. This is the follow-up
/// `recording://state` event the initial `start_recording` emission cannot
/// carry: the capture backend resolves the source only once the system-audio
/// tap actually starts, well after `RecordingSession::start` returned, and
/// without this announcement the UI would show the degraded "Mic only
/// (system audio unavailable)" label for an entire healthy mixed recording.
///
/// Extracted from `run_worker`'s `on_system_source` callback so the
/// store-then-announce contract is unit-testable without a real audio
/// device or a Tauri `AppHandle`. Never runs on the realtime audio
/// callback: `capture_sources` invokes it once, on the capture worker
/// thread, right after the system-audio backend starts.
pub fn announce_resolved_system_source(
    slot: &Mutex<Option<SystemAudioSource>>,
    emit: impl FnOnce(Option<SystemAudioSource>),
    resolved: SystemAudioSource,
) {
    if let Ok(mut guard) = slot.lock() {
        *guard = Some(resolved.clone());
    }
    emit(Some(resolved));
}

/// Bounded capacity, in audio chunks, of the handoff channel between the
/// audio callback and the decode worker.
///
/// Sized for roughly 3 seconds of headroom assuming ~20 ms callback
/// blocks — the block size this codebase's overrun measurements used
/// (`deadline=20.0ms` over 750 chunks / 15 s of speech) — enough to
/// absorb one slow decode without dropping audio, while still bounding
/// memory if the decode worker falls permanently behind. Doubled from 150
/// to 300 for dual-track capture: the same wall-clock recording can now
/// enqueue up to two chunks per callback (mic and system), so the prior
/// capacity gave half the headroom in samples-of-audio terms it used to.
const DECODE_CHANNEL_CAPACITY: usize = 300;

/// Which captured audio track a chunk handed to the decode worker (or a
/// finalized/partial transcript event) came from. Drives per-segment
/// speaker attribution: [`Track::Mic`] is always the local user
/// ([`Speaker::me`]), [`Track::System`] is an unidentified other
/// participant ([`Speaker::others`]) — there is no diarization, so a
/// specific `others:<id>` is never fabricated here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Track {
    Mic,
    System,
}

/// A live recording: owns the worker thread that captures audio, records
/// it to disk, and streams it through VAD + STT.
pub struct RecordingSession {
    pub meeting_id: MeetingId,
    /// The effective capture source this session is recording from — the
    /// result of [`resolve_capture_source`], already resolved before the
    /// session was started.
    pub source: CaptureSource,
    /// The effective system-audio source in use, once the capture backend
    /// has resolved one. `None` while `source` is `Microphone`, or before
    /// the worker thread's capture has started — see
    /// [`RecordingSession::system_source`].
    system_source: Arc<Mutex<Option<SystemAudioSource>>>,
    stop: Arc<AtomicBool>,
    worker: JoinHandle<Result<(Transcript, u32), AppError>>,
    started_at: Instant,
}

/// Grouped capture-selection parameters for [`RecordingSession::start`] —
/// pulled out of that function's argument list (rather than three separate
/// parameters) to keep its arity within clippy's `too_many_arguments` limit.
pub struct CaptureSelection {
    /// Already resolved by [`resolve_capture_source`].
    pub source: CaptureSource,
    /// The input device to use when `source` uses the microphone.
    pub device: Option<DeviceInfo>,
    /// Already resolved by [`resolve_system_source_id`].
    pub system_source_id: Option<String>,
}

/// The file paths a recording writes to — the three WAVs plus the
/// transcript journal — grouped, like [`CaptureSelection`], to keep
/// [`RecordingSession::start`]'s argument list within clippy's
/// `too_many_arguments` limit. See the module docs for what each file is
/// for.
pub struct AudioPaths {
    /// Device-native-rate stereo playback/export copy. Its [`WavRecorder`]
    /// is created lazily on the worker thread, once
    /// `myna_audio::capture_sources`'s `on_native_rate` callback reports the
    /// authoritative rate — never eagerly here, since that rate isn't known
    /// synchronously ahead of capture.
    pub playback: PathBuf,
    /// 16 kHz mono STT-grade microphone track. Created only when `source`
    /// can ever populate [`TrackBlock::mic`] (see [`source_has_mic`]).
    pub mic: PathBuf,
    /// 16 kHz mono STT-grade system-audio track. Created only when `source`
    /// can ever populate [`TrackBlock::system`] (see [`source_has_system`]).
    pub system: PathBuf,
    /// Append-only transcript journal (`transcript-journal.jsonl`): one
    /// finalized [`TranscriptSegment`] per line, written by the decode
    /// worker so live finals survive a crash between capture-stop and
    /// meeting-save (see [`crate::session_manifest`]). Deleted by
    /// `stop_recording` once the finished meeting has been persisted.
    pub journal_path: PathBuf,
}

/// Whether `source` can ever populate [`TrackBlock::mic`] — mirrors
/// `myna_audio::capture_sources`'s own per-source contract (see
/// [`TrackBlock`]'s docs), so the mic WAV file and STT streamer are only
/// ever created when they could receive audio; a source that never
/// populates a track must never leave behind an empty file for it.
pub fn source_has_mic(source: CaptureSource) -> bool {
    matches!(source, CaptureSource::Microphone | CaptureSource::Mixed)
}

/// Whether `source` can ever populate [`TrackBlock::system`] — see
/// [`source_has_mic`].
pub fn source_has_system(source: CaptureSource) -> bool {
    matches!(source, CaptureSource::System | CaptureSource::Mixed)
}

/// Opens the mic/system 16 kHz mono WAV recorders for `source`, gated by
/// [`source_has_mic`]/[`source_has_system`] so a track absent for `source`
/// never gets an empty file created for it. Extracted from
/// [`RecordingSession::start`] so this policy is directly testable without
/// a real audio device — see `tests/session.rs`.
pub fn open_track_wavs(
    source: CaptureSource,
    audio_paths: &AudioPaths,
    track_spec: RecordingSpec,
) -> Result<(Option<WavRecorder>, Option<WavRecorder>), AppError> {
    let mic_wav = source_has_mic(source)
        .then(|| WavRecorder::create(&audio_paths.mic, track_spec))
        .transpose()?;
    let system_wav = source_has_system(source)
        .then(|| WavRecorder::create(&audio_paths.system, track_spec))
        .transpose()?;
    Ok((mic_wav, system_wav))
}

/// Creates the device-native-rate stereo `WavRecorder` for `audio.wav` at
/// `path`, once `native_rate` is authoritatively known (see
/// [`create_playback_wav`] and the module docs). Extracted so the header
/// this produces is directly testable without a real audio device — see
/// `tests/session.rs`.
pub fn create_playback_recorder(
    path: &std::path::Path,
    native_rate: u32,
) -> Result<WavRecorder, AppError> {
    let spec = RecordingSpec {
        sample_rate: native_rate,
        channels: 2,
    };
    WavRecorder::create(path, spec).map_err(AppError::from)
}

/// Maps a [`Track`] to the [`Speaker`] every event decoded from it is
/// stamped with: [`Track::Mic`] is always [`Speaker::me`], [`Track::System`]
/// is always bare [`Speaker::others`] — there is no diarization, so a
/// specific `others:<id>` is never fabricated. Extracted from
/// [`apply_event`] so the mapping is directly unit-testable.
pub fn speaker_for_track(track: Track) -> Speaker {
    match track {
        Track::Mic => Speaker::me(),
        Track::System => Speaker::others(),
    }
}

impl RecordingSession {
    /// Starts a new recording session for `meeting_id`, capturing per
    /// `selection`.
    ///
    /// The mic/system WAV recorders and STT streamers are built
    /// synchronously so setup failures (an unwritable path, a missing VAD
    /// model) surface immediately to the caller; only the device capture
    /// itself — which blocks until stopped — runs on the spawned worker
    /// thread. `audio_paths.playback`'s [`WavRecorder`] is the one
    /// exception: its native sample rate isn't known until capture actually
    /// starts (see the module docs), so it's created lazily on the worker
    /// thread instead, once `on_native_rate` fires. That means
    /// [`RecordingSession::system_source`] may still report `None`
    /// immediately after this returns, until the worker thread's capture
    /// actually starts and resolves one — at which point the worker emits
    /// a follow-up `recording://state` event carrying it (see
    /// [`announce_resolved_system_source`]).
    pub fn start(
        app: AppHandle,
        meeting_id: MeetingId,
        selection: CaptureSelection,
        audio_paths: AudioPaths,
        engine: Arc<SttEngine>,
        vad_cfg: &VadConfig,
    ) -> Result<Self, AppError> {
        let CaptureSelection {
            source,
            device,
            system_source_id,
        } = selection;

        let capture_config = CaptureConfig::default();
        let track_spec = RecordingSpec {
            sample_rate: capture_config.sample_rate,
            channels: capture_config.channels,
        };

        let (mic_wav, system_wav) = open_track_wavs(source, &audio_paths, track_spec)?;

        // Open the transcript journal eagerly so an unwritable path is at
        // least visible in logs from the moment of the failed start — but
        // never fatal: a journal failure degrades crash resilience, it
        // must not cost the user the recording itself (the WAVs and the
        // in-memory transcript are unaffected).
        let journal = match JournalWriter::create(&audio_paths.journal_path) {
            Ok(writer) => Some(writer),
            Err(err) => {
                eprintln!(
                    "myna-app: failed to open transcript journal {:?} for meeting {meeting_id}: \
                     {err} — finalized segments will not survive a crash mid-recording",
                    audio_paths.journal_path
                );
                None
            }
        };

        let mic_streamer = source_has_mic(source)
            .then(|| SimulatedStreamer::new(Arc::clone(&engine), vad_cfg))
            .transpose()?;
        let system_streamer = source_has_system(source)
            .then(|| SimulatedStreamer::new(Arc::clone(&engine), vad_cfg))
            .transpose()?;

        let worker_state = Arc::new(Mutex::new(WorkerState {
            playback_wav: None,
            mic_wav,
            system_wav,
            level_throttle: LevelThrottle::new(LEVEL_EMIT_INTERVAL_MS),
            error: None,
        }));

        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);

        let system_source = Arc::new(Mutex::new(None));
        let system_source_for_worker = Arc::clone(&system_source);

        let capture_params = CaptureParams {
            source,
            device,
            system_source: system_source_id,
            capture_config,
        };

        let worker = thread::spawn(move || {
            run_worker(
                app,
                meeting_id,
                capture_params,
                audio_paths.playback,
                journal,
                mic_streamer,
                system_streamer,
                worker_state,
                worker_stop,
                system_source_for_worker,
            )
        });

        Ok(Self {
            meeting_id,
            source,
            system_source,
            stop,
            worker,
            started_at: Instant::now(),
        })
    }

    /// The effective system-audio source in use right now: `None` while
    /// `source` is `Microphone`, or before the worker thread's capture has
    /// resolved one yet — at which point the worker has already announced
    /// the resolved source to the UI via a follow-up `recording://state`
    /// event (see [`announce_resolved_system_source`]).
    pub fn system_source(&self) -> Option<SystemAudioSource> {
        self.system_source
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }

    /// Signals the worker to stop, joins it, and returns its result: the
    /// finished transcript and the count of audio chunks silently dropped
    /// during this recording (see [`DecodeChannel::dropped_count`]) —
    /// alongside any capture or decode error, which is never discarded.
    pub fn stop(self) -> Result<(Transcript, u32), AppError> {
        self.stop.store(true, Ordering::Relaxed);
        self.worker.join().unwrap_or_else(|_| {
            Err(AppError::Store(
                "recording worker thread panicked".to_string(),
            ))
        })
    }

    /// Wall-clock time elapsed since the session started, in seconds.
    pub fn elapsed_sec(&self) -> f32 {
        self.started_at.elapsed().as_secs_f32()
    }
}

/// Mutable state shared between the worker thread and the cpal audio
/// callback, which may run on its own internal thread while
/// `capture_sources` blocks the worker thread.
///
/// Deliberately holds only cheap, bounded work: the WAV recorders and the
/// level throttle. The [`SimulatedStreamer`]s — the expensive, unbounded
/// part — live on the decode worker instead, reachable only through
/// [`DecodeChannel`], never through this mutex. See the module docs for
/// why that split exists.
///
/// `mic_wav`/`system_wav` are `Some` from construction whenever `source`
/// can populate that track (see [`source_has_mic`]/[`source_has_system`]) —
/// never created empty otherwise. `playback_wav` starts `None` and is
/// populated exactly once, from the worker thread's `on_native_rate`
/// callback, the moment `myna_audio::capture_sources` reports the
/// authoritative native rate (see the module docs) — never from the
/// realtime audio callback itself.
struct WorkerState {
    playback_wav: Option<WavRecorder>,
    mic_wav: Option<WavRecorder>,
    system_wav: Option<WavRecorder>,
    level_throttle: LevelThrottle,
    error: Option<AppError>,
}

/// Owned bundle of the capture parameters `run_worker` needs, grouped so
/// the function stays within a reasonable argument count.
/// [`CaptureRequest`] itself can't be stored directly here — it borrows
/// `device` — so `run_worker` rebuilds one from these fields just before
/// calling `capture_sources`.
struct CaptureParams {
    source: CaptureSource,
    device: Option<DeviceInfo>,
    system_source: Option<String>,
    capture_config: CaptureConfig,
}

/// Runs on a dedicated thread: spawns the decode worker, opens the audio
/// device (blocking until `stop` is set), then finalizes the WAV file and
/// joins the decode worker so its final segment is never lost.
///
/// Returns the finished transcript alongside the total count of audio
/// chunks the [`DecodeChannel`] silently dropped over the recording — read
/// via a cloned counter handle taken *before* the channel is moved into the
/// audio callback (and dropped once `capture_sources` returns), so the
/// count is still readable afterwards.
#[allow(clippy::too_many_arguments)]
fn run_worker(
    app: AppHandle,
    meeting_id: MeetingId,
    capture_params: CaptureParams,
    playback_path: PathBuf,
    journal: Option<JournalWriter>,
    mic_streamer: Option<SimulatedStreamer>,
    system_streamer: Option<SimulatedStreamer>,
    worker_state: Arc<Mutex<WorkerState>>,
    stop: Arc<AtomicBool>,
    system_source: Arc<Mutex<Option<SystemAudioSource>>>,
) -> Result<(Transcript, u32), AppError> {
    let (decode_tx, decode_rx) = sync_channel::<(Track, Vec<f32>)>(DECODE_CHANNEL_CAPACITY);
    let decode_channel = DecodeChannel::new(decode_tx);
    let dropped_counter = decode_channel.dropped_handle();
    let decode_worker = spawn_decode_worker(
        app.clone(),
        meeting_id,
        journal,
        mic_streamer,
        system_streamer,
        decode_rx,
        Arc::clone(&stop),
    );

    let callback_stop = Arc::clone(&stop);
    let on_samples = build_sample_callback(
        app.clone(),
        Arc::clone(&worker_state),
        decode_channel,
        callback_stop,
    );
    // Clones for the `on_native_rate` callback below, which lazily creates
    // `audio.wav` the moment the authoritative native playback rate is
    // known — see the module docs and `create_playback_wav`.
    let native_rate_state = Arc::clone(&worker_state);
    let native_rate_stop = Arc::clone(&stop);
    // Clones for the `on_system_source` callback below, which announces the
    // resolved system-audio source to the UI via a follow-up
    // `recording://state` event (see `announce_resolved_system_source`).
    let state_app = app.clone();
    let state_meeting_id = meeting_id;
    let state_source = capture_params.source;
    let capture_request = CaptureRequest {
        source: capture_params.source,
        device: capture_params.device.as_ref(),
        system_source: capture_params.system_source.as_deref(),
        config: capture_params.capture_config,
    };
    // `stop` is moved into `capture_sources` here — its last use. Once
    // `capture_sources` returns, `on_samples` (and the `DecodeChannel`,
    // and its `SyncSender`, it captured) is dropped, which disconnects
    // the decode channel and lets `decode_worker`'s receive loop end on
    // its own, so the join below never blocks on a hung producer.
    let capture_result = capture_sources(
        &capture_request,
        stop,
        on_samples,
        move |resolved| {
            announce_resolved_system_source(
                &system_source,
                |source| {
                    // Borrows `state_app` (rather than moving it) so the outer
                    // `on_system_source` callback stays `FnMut` as
                    // `capture_sources` requires.
                    emit_recording_state(
                        &state_app,
                        Some(state_meeting_id),
                        RecordingState::Recording,
                        state_source,
                        source,
                    );
                },
                resolved,
            );
        },
        move |rate: u32| {
            create_playback_wav(&native_rate_state, &playback_path, rate, &native_rate_stop);
        },
    );

    let WorkerState {
        playback_wav,
        mic_wav,
        system_wav,
        error,
        ..
    } = unwrap_worker_state(worker_state)?;

    let decode_result = decode_worker
        .join()
        .unwrap_or_else(|_| Err(AppError::Store("decode worker thread panicked".to_string())));

    capture_result?;
    if let Some(err) = error {
        return Err(err);
    }

    // `playback_wav` is `None` only when `on_native_rate` never fired at
    // all — i.e. capture failed before any rate could ever be resolved, in
    // which case `capture_result?` above has already returned that error.
    if let Some(playback_wav) = playback_wav {
        playback_wav.finalize()?;
    }
    if let Some(mic_wav) = mic_wav {
        mic_wav.finalize()?;
    }
    if let Some(system_wav) = system_wav {
        system_wav.finalize()?;
    }

    let transcript = decode_result?;
    let dropped_chunks = dropped_counter.load(Ordering::Relaxed) as u32;
    Ok((transcript, dropped_chunks))
}

/// Creates `audio.wav` the moment `myna_audio::capture_sources` reports the
/// authoritative native playback rate via `on_native_rate` — see the module
/// docs and [`AudioPaths::playback`]. Runs on the capture worker thread, at
/// stream-setup time, strictly before any `playback` block could ever be
/// non-empty (see `capture_sources`'s own doc contract for `on_native_rate`)
/// — never on the realtime audio callback thread, so this file I/O is never
/// budget-constrained the way `build_sample_callback` is.
///
/// On a create failure (e.g. an unwritable path), records the error into
/// `state` and requests an early stop, exactly like a WAV write failure
/// inside the callback itself.
fn create_playback_wav(
    state: &Arc<Mutex<WorkerState>>,
    path: &std::path::Path,
    native_rate: u32,
    stop: &Arc<AtomicBool>,
) {
    match create_playback_recorder(path, native_rate) {
        Ok(recorder) => {
            if let Ok(mut state) = state.lock() {
                state.playback_wav = Some(recorder);
            }
        }
        Err(err) => {
            if let Ok(mut state) = state.lock() {
                state.error = Some(err);
            }
            stop.store(true, Ordering::Relaxed);
        }
    }
}

/// Owns both [`SimulatedStreamer`]s — [`Track::Mic`] and [`Track::System`],
/// sharing one [`SttEngine`] `Arc` between them — and turns buffered
/// per-track audio into transcript events entirely off the audio callback
/// thread. A single worker thread dispatches by [`Track`] rather than one
/// thread per streamer, so decode stays exactly as serialized (and ORT
/// thread parallelism exactly as unchanged) as it was with one streamer.
///
/// Either streamer is `None` when `source` never populates that track (see
/// [`source_has_mic`]/[`source_has_system`]); a chunk arriving for a track
/// with no streamer is a should-never-happen defensive case, silently
/// skipped rather than panicking.
///
/// Runs until `rx` disconnects — which happens once the audio callback
/// (and the [`DecodeChannel`] it captured) is dropped when capture stops
/// — then flushes each present streamer's trailing audio via `finish()` so
/// the final segment on both tracks is never lost. On a decode error on
/// either track, requests an early stop (via `stop`) rather than continuing
/// to decode audio no one can use.
///
/// `journal` (when present) receives every [`SttEvent::Final`] segment the
/// worker folds into `transcript`, appended right after the in-memory fold
/// and before the event is emitted. This runs on the decode worker thread,
/// never the realtime audio callback. A journal write failure is logged to
/// stderr and ignored — it must never abort capture or drop the transcript
/// the user is watching live.
fn spawn_decode_worker(
    app: AppHandle,
    meeting_id: MeetingId,
    journal: Option<JournalWriter>,
    mut mic_streamer: Option<SimulatedStreamer>,
    mut system_streamer: Option<SimulatedStreamer>,
    rx: Receiver<(Track, Vec<f32>)>,
    stop: Arc<AtomicBool>,
) -> JoinHandle<Result<Transcript, AppError>> {
    thread::spawn(move || {
        let mut transcript = Transcript::default();
        let mut journal = journal;

        for (track, samples) in rx {
            let streamer = match track {
                Track::Mic => mic_streamer.as_mut(),
                Track::System => system_streamer.as_mut(),
            };
            let Some(streamer) = streamer else {
                continue;
            };
            match streamer.push(&samples) {
                Ok(events) => {
                    for event in events {
                        apply_event(
                            &app,
                            meeting_id,
                            &mut transcript,
                            &mut journal,
                            track,
                            event,
                        );
                    }
                }
                Err(err) => {
                    stop.store(true, Ordering::Relaxed);
                    return Err(AppError::from(err));
                }
            }
        }

        if let Some(streamer) = mic_streamer.as_mut() {
            for event in streamer.finish()? {
                apply_event(
                    &app,
                    meeting_id,
                    &mut transcript,
                    &mut journal,
                    Track::Mic,
                    event,
                );
            }
        }
        if let Some(streamer) = system_streamer.as_mut() {
            for event in streamer.finish()? {
                apply_event(
                    &app,
                    meeting_id,
                    &mut transcript,
                    &mut journal,
                    Track::System,
                    event,
                );
            }
        }

        Ok(transcript)
    })
}

/// Bounded, non-blocking handoff from the real-time audio callback to the
/// decode worker thread.
///
/// Wraps a [`sync_channel`]'s [`SyncSender`] behind [`SyncSender::try_send`],
/// so the audio callback — which must return in roughly 20 ms on a real
/// device — can never block on a full channel or a stalled/slow decode.
/// On overflow, the incoming chunk (not the already-buffered ones) is
/// dropped and counted; [`DecodeChannel::send`] logs a warning exactly
/// once so sustained overload is visible without flooding stderr on every
/// subsequent overflow.
pub struct DecodeChannel {
    sender: SyncSender<(Track, Vec<f32>)>,
    dropped: Arc<AtomicUsize>,
    warned: Arc<AtomicBool>,
}

impl DecodeChannel {
    pub fn new(sender: SyncSender<(Track, Vec<f32>)>) -> Self {
        Self {
            sender,
            dropped: Arc::new(AtomicUsize::new(0)),
            warned: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Hands `samples` for `track` to the decode worker without ever
    /// blocking the caller. On a full (or disconnected) channel, drops
    /// `samples` and counts the drop rather than waiting for room.
    pub fn send(&self, track: Track, samples: Vec<f32>) {
        match self.sender.try_send((track, samples)) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                if !self.warned.swap(true, Ordering::Relaxed) {
                    eprintln!(
                        "myna-app: decode channel overflow — the decode worker is falling \
                         behind live audio; further overflows are counted but not logged"
                    );
                }
            }
        }
    }

    /// Total number of audio chunks dropped so far because the channel
    /// was full (or already disconnected).
    pub fn dropped_count(&self) -> usize {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Returns a cloned handle to the drop counter, so the count stays
    /// readable even after this `DecodeChannel` itself has been moved into
    /// the audio callback and later dropped.
    pub fn dropped_handle(&self) -> Arc<AtomicUsize> {
        Arc::clone(&self.dropped)
    }
}

/// Reclaims the [`WorkerState`] once the audio callback (and its `Arc`
/// clone of `worker_state`) has been dropped by `capture` returning.
fn unwrap_worker_state(worker_state: Arc<Mutex<WorkerState>>) -> Result<WorkerState, AppError> {
    Arc::try_unwrap(worker_state)
        .map_err(|_| {
            AppError::Store("recording worker state still shared after capture stopped".into())
        })?
        .into_inner()
        .map_err(|_| AppError::Store("recording worker state mutex poisoned".into()))
}

/// Builds the `FnMut` sample callback passed to `myna_audio::capture_sources`.
///
/// Does only cheap, bounded work per block: up to three `write_all`s (mic,
/// system, native-rate stereo playback — see [`write_tracks`]), the
/// throttled level meter over the mono sum, and up to two non-blocking
/// [`DecodeChannel::send`]s — never a decode, never an allocation beyond
/// what a `write` itself needs. The `worker_state` lock is held only across
/// the WAV writes and level throttle, and is released (see the explicit
/// `drop` below) before either `decode_channel.send`, which never blocks
/// regardless.
///
/// On a WAV write error, records it and requests an early stop rather
/// than continuing to capture audio no one can use.
fn build_sample_callback(
    app: AppHandle,
    worker_state: Arc<Mutex<WorkerState>>,
    decode_channel: DecodeChannel,
    stop: Arc<AtomicBool>,
) -> impl FnMut(&TrackBlock<'_>) + Send + 'static {
    // Reconstructs the same mono mix `myna-audio` used to produce itself,
    // purely to feed the throttled level meter a single number — the WAV
    // files below write each present track (and native-rate stereo
    // `playback`) unsummed. `mix_buffer` is reused across calls rather than
    // allocated fresh each block — this runs on the realtime mic callback
    // thread.
    let mut mix_buffer: Vec<f32> = Vec::new();
    move |block: &TrackBlock<'_>| {
        let level_samples: Option<&[f32]> = match (block.mic, block.system) {
            (Some(mic), Some(system)) => {
                let len = mic.len().min(system.len());
                mix_buffer.resize(len, 0.0);
                mix_into(mic, system, &mut mix_buffer);
                Some(&mix_buffer[..len])
            }
            (Some(mic), None) => Some(mic),
            (None, Some(system)) => Some(system),
            (None, None) => None,
        };

        let mut state = match worker_state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        if state.error.is_some() {
            return;
        }

        if let Err(err) = write_tracks(&mut state, block) {
            state.error = Some(AppError::from(err));
            stop.store(true, Ordering::Relaxed);
            return;
        }

        if let Some(level_samples) = level_samples {
            if state.level_throttle.should_emit(Instant::now()) {
                emit_level(&app, level_samples);
            }
        }

        drop(state);

        if let Some(mic) = block.mic {
            decode_channel.send(Track::Mic, mic.to_vec());
        }
        if let Some(system) = block.system {
            decode_channel.send(Track::System, system.to_vec());
        }
    }
}

/// Writes each track present in `block` to its matching [`WorkerState`] WAV
/// recorder, when one exists yet. `playback_wav` may still be `None` in the
/// should-never-happen-in-practice window before `on_native_rate` has fired
/// (see [`create_playback_wav`]) — that block's `playback` samples are
/// silently dropped rather than written at a guessed/garbage rate, never
/// buffered for later (no bound on how long "later" could be). Stops at the
/// first write error, leaving any later track unwritten for this block —
/// [`build_sample_callback`] records the error and requests a stop
/// immediately after.
fn write_tracks(
    state: &mut WorkerState,
    block: &TrackBlock<'_>,
) -> Result<(), myna_audio::AudioError> {
    if let (Some(mic), Some(mic_wav)) = (block.mic, state.mic_wav.as_mut()) {
        mic_wav.write(mic)?;
    }
    if let (Some(system), Some(system_wav)) = (block.system, state.system_wav.as_mut()) {
        system_wav.write(system)?;
    }
    if !block.playback.is_empty() {
        if let Some(playback_wav) = state.playback_wav.as_mut() {
            playback_wav.write(block.playback)?;
        }
    }
    Ok(())
}

/// Stamps `event`'s speaker from `track` and, for a [`SttEvent::Final`],
/// inserts the stamped segment into `transcript` at its sorted position by
/// `start_sec` (see [`crate::ingest::insert_final_segment`]) — never simply
/// appended.
///
/// This matters because the decode worker dispatches both tracks off a
/// single, real-time-ordered channel (see [`spawn_decode_worker`]): each
/// [`SimulatedStreamer`] only yields a [`SttEvent::Final`] once its own VAD
/// segment finishes, and a long segment on one track (e.g. ~20 s of
/// continuous system audio) can finish well after several shorter segments
/// on the other track have already been applied — even though both
/// streamers share the same sample clock from a common recording start, so
/// every segment's `start_sec` *is* directly comparable across tracks. Live
/// decode-completion order is therefore not chronological order; only a
/// sorted insert keeps the persisted transcript ordered ascending by
/// `start_sec` the way [`crate::ingest::merge_track_transcripts`] already
/// guarantees for the offline re-transcribe path.
///
/// Extracted from [`apply_event`] so this policy is directly unit-testable
/// without an [`AppHandle`] — see `tests/session.rs`.
pub fn fold_track_event(
    transcript: &mut Transcript,
    track: Track,
    event: SttEvent,
) -> (Speaker, SttEvent) {
    let speaker = speaker_for_track(track);
    match event {
        SttEvent::Partial { text } => (speaker, SttEvent::Partial { text }),
        SttEvent::Final { segment } => {
            let segment = TranscriptSegment {
                speaker: speaker.clone(),
                ..segment
            };
            crate::ingest::insert_final_segment(transcript, segment.clone());
            (speaker, SttEvent::Final { segment })
        }
    }
}

/// Applies one [`SttEvent`] decoded from `track`, folding final segments
/// into `transcript` (see [`fold_track_event`]), journaling every final
/// segment right after the in-memory fold (see [`JournalWriter`]), and
/// emitting the matching transcript event either way.
///
/// The journal write happens on the decode worker thread — never the
/// realtime callback — and its failure is logged and swallowed: losing the
/// crash-recovery copy of one segment must never abort the recording the
/// user is live-watching.
fn apply_event(
    app: &AppHandle,
    meeting_id: MeetingId,
    transcript: &mut Transcript,
    journal: &mut Option<JournalWriter>,
    track: Track,
    event: SttEvent,
) {
    let (speaker, event) = fold_track_event(transcript, track, event);
    match event {
        SttEvent::Partial { text } => emit_partial(app, meeting_id, text, speaker),
        SttEvent::Final { segment } => {
            if let Some(writer) = journal {
                if let Err(err) = writer.append(&segment) {
                    eprintln!(
                        "myna-app: transcript journal append failed for meeting {meeting_id}: \
                         {err} — continuing to record regardless"
                    );
                }
            }
            emit_final(app, meeting_id, segment);
        }
    }
}

fn emit_level(app: &AppHandle, samples: &[f32]) {
    let payload = LevelPayload {
        rms: rms(samples),
        dbfs: rms_dbfs(samples),
    };
    let _ = app.emit(RECORDING_LEVEL, payload);
}

fn emit_partial(app: &AppHandle, meeting_id: MeetingId, text: String, speaker: Speaker) {
    let payload = PartialPayload {
        meeting_id: meeting_id.to_string(),
        text,
        speaker: speaker.as_str().to_string(),
    };
    let _ = app.emit(TRANSCRIPT_PARTIAL, payload);
}

fn emit_final(app: &AppHandle, meeting_id: MeetingId, segment: TranscriptSegment) {
    let payload = FinalPayload {
        meeting_id: meeting_id.to_string(),
        segment,
    };
    let _ = app.emit(TRANSCRIPT_FINAL, payload);
}
