//! Recording session state machine.
//!
//! [`RecordingSession`] owns two threads for one recording: a capture
//! worker that opens the (blocking) audio device and writes the WAV file,
//! and a decode worker that owns the [`SimulatedStreamer`] and turns
//! buffered audio into transcript events.
//!
//! This split matters because the audio callback cpal drives from
//! `capture_sources` runs on a real-time thread that must return in
//! roughly 20 ms. A full Parakeet decode measured 700 ms-p50 / 2.3 s-max
//! over live speech — running it inline in that callback (as this module
//! used to) starved the callback deadline so badly that over 97% of
//! captured audio was silently lost. [`DecodeChannel`] is the fix: a
//! bounded, non-blocking handoff from the callback to the decode worker
//! thread, so the callback's only job is writing the WAV file, computing
//! the level, and handing samples off — never waiting on a decode.
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
    capture_sources, rms, rms_dbfs, CaptureConfig, CaptureRequest, CaptureSource, DeviceInfo,
    RecordingSpec, SystemAudioSource, SystemAudioStatus, WavRecorder,
};
use myna_stt::{SimulatedStreamer, SttEngine, SttEvent, Transcript, TranscriptSegment, VadConfig};

use crate::domain::MeetingId;
use crate::error::AppError;
use crate::events::{
    FinalPayload, LevelPayload, PartialPayload, RECORDING_LEVEL, TRANSCRIPT_FINAL,
    TRANSCRIPT_PARTIAL,
};

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

/// Pure guard for starting a recording: `Busy` when one is already active.
///
/// Extracted from [`RecordingSession`] itself so the start/stop busy-check
/// transitions are unit-testable against a plain `bool` rather than a real,
/// device-backed session.
pub fn guard_start(has_active_session: bool) -> Result<(), AppError> {
    if has_active_session {
        Err(AppError::Busy("a recording is already in progress"))
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

/// Bounded capacity, in audio chunks, of the handoff channel between the
/// audio callback and the decode worker.
///
/// Sized for roughly 3 seconds of headroom assuming ~20 ms callback
/// blocks — the block size this codebase's overrun measurements used
/// (`deadline=20.0ms` over 750 chunks / 15 s of speech) — enough to
/// absorb one slow decode without dropping audio, while still bounding
/// memory if the decode worker falls permanently behind.
const DECODE_CHANNEL_CAPACITY: usize = 150;

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
    worker: JoinHandle<Result<Transcript, AppError>>,
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

impl RecordingSession {
    /// Starts a new recording session for `meeting_id`, capturing per
    /// `selection`.
    ///
    /// The WAV recorder and STT streamer are built synchronously so setup
    /// failures (an unwritable path, a missing VAD model) surface
    /// immediately to the caller; only the device capture itself — which
    /// blocks until stopped — runs on the spawned worker thread. That
    /// means [`RecordingSession::system_source`] may still report `None`
    /// immediately after this returns, until the worker thread's capture
    /// actually starts and resolves one.
    pub fn start(
        app: AppHandle,
        meeting_id: MeetingId,
        selection: CaptureSelection,
        audio_path: PathBuf,
        engine: Arc<SttEngine>,
        vad_cfg: &VadConfig,
    ) -> Result<Self, AppError> {
        let CaptureSelection {
            source,
            device,
            system_source_id,
        } = selection;

        let capture_config = CaptureConfig::default();
        let recording_spec = RecordingSpec {
            sample_rate: capture_config.sample_rate,
            channels: capture_config.channels,
        };

        let wav_recorder = WavRecorder::create(&audio_path, recording_spec)?;
        let streamer = SimulatedStreamer::new(engine, vad_cfg)?;

        let worker_state = Arc::new(Mutex::new(WorkerState {
            wav_recorder,
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
                streamer,
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
    /// resolved one yet.
    pub fn system_source(&self) -> Option<SystemAudioSource> {
        self.system_source
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }

    /// Signals the worker to stop, joins it, and returns its result —
    /// including any capture or decode error, which is never discarded.
    pub fn stop(self) -> Result<Transcript, AppError> {
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
/// Deliberately holds only cheap, bounded work: the WAV recorder and the
/// level throttle. The [`SimulatedStreamer`] — the expensive, unbounded
/// part — lives on the decode worker instead, reachable only through
/// [`DecodeChannel`], never through this mutex. See the module docs for
/// why that split exists.
struct WorkerState {
    wav_recorder: WavRecorder,
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
fn run_worker(
    app: AppHandle,
    meeting_id: MeetingId,
    capture_params: CaptureParams,
    streamer: SimulatedStreamer,
    worker_state: Arc<Mutex<WorkerState>>,
    stop: Arc<AtomicBool>,
    system_source: Arc<Mutex<Option<SystemAudioSource>>>,
) -> Result<Transcript, AppError> {
    let (decode_tx, decode_rx) = sync_channel::<Vec<f32>>(DECODE_CHANNEL_CAPACITY);
    let decode_channel = DecodeChannel::new(decode_tx);
    let decode_worker = spawn_decode_worker(
        app.clone(),
        meeting_id,
        streamer,
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
    let capture_result = capture_sources(&capture_request, stop, on_samples, move |resolved| {
        if let Ok(mut slot) = system_source.lock() {
            *slot = Some(resolved);
        }
    });

    let WorkerState {
        wav_recorder,
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

    wav_recorder.finalize()?;

    decode_result
}

/// Owns the [`SimulatedStreamer`] and turns buffered audio into transcript
/// events entirely off the audio callback thread.
///
/// Runs until `rx` disconnects — which happens once the audio callback
/// (and the [`DecodeChannel`] it captured) is dropped when capture stops
/// — then flushes the streamer's trailing audio via `finish()` so the
/// final segment is never lost. On a decode error, requests an early stop
/// (via `stop`) rather than continuing to decode audio no one can use.
fn spawn_decode_worker(
    app: AppHandle,
    meeting_id: MeetingId,
    mut streamer: SimulatedStreamer,
    rx: Receiver<Vec<f32>>,
    stop: Arc<AtomicBool>,
) -> JoinHandle<Result<Transcript, AppError>> {
    thread::spawn(move || {
        let mut transcript = Transcript::default();

        for samples in rx {
            match streamer.push(&samples) {
                Ok(events) => {
                    for event in events {
                        apply_event(&app, meeting_id, &mut transcript, event);
                    }
                }
                Err(err) => {
                    stop.store(true, Ordering::Relaxed);
                    return Err(AppError::from(err));
                }
            }
        }

        for event in streamer.finish()? {
            apply_event(&app, meeting_id, &mut transcript, event);
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
    sender: SyncSender<Vec<f32>>,
    dropped: Arc<AtomicUsize>,
    warned: Arc<AtomicBool>,
}

impl DecodeChannel {
    pub fn new(sender: SyncSender<Vec<f32>>) -> Self {
        Self {
            sender,
            dropped: Arc::new(AtomicUsize::new(0)),
            warned: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Hands `samples` to the decode worker without ever blocking the
    /// caller. On a full (or disconnected) channel, drops `samples` and
    /// counts the drop rather than waiting for room.
    pub fn send(&self, samples: Vec<f32>) {
        match self.sender.try_send(samples) {
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

/// Builds the `FnMut` sample callback passed to `myna_audio::capture`.
///
/// Does only cheap, bounded work — write to the WAV file, compute the
/// level, hand samples off to the decode worker — and never decodes
/// inline. The `worker_state` lock is held only across the WAV write and
/// level throttle, and is released (see the explicit `drop` below)
/// before `decode_channel.send`, which never blocks regardless.
///
/// On a WAV write error, records it and requests an early stop rather
/// than continuing to capture audio no one can use.
fn build_sample_callback(
    app: AppHandle,
    worker_state: Arc<Mutex<WorkerState>>,
    decode_channel: DecodeChannel,
    stop: Arc<AtomicBool>,
) -> impl FnMut(&[f32]) + Send + 'static {
    move |samples: &[f32]| {
        let mut state = match worker_state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        if state.error.is_some() {
            return;
        }

        if let Err(err) = state.wav_recorder.write(samples) {
            state.error = Some(AppError::from(err));
            stop.store(true, Ordering::Relaxed);
            return;
        }

        if state.level_throttle.should_emit(Instant::now()) {
            emit_level(&app, samples);
        }

        drop(state);
        decode_channel.send(samples.to_vec());
    }
}

/// Applies one [`SttEvent`], appending final segments to `transcript` and
/// emitting the matching transcript event either way.
fn apply_event(
    app: &AppHandle,
    meeting_id: MeetingId,
    transcript: &mut Transcript,
    event: SttEvent,
) {
    match event {
        SttEvent::Partial { text } => emit_partial(app, meeting_id, text),
        SttEvent::Final { segment } => {
            *transcript = transcript.with_segment(segment.clone());
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

fn emit_partial(app: &AppHandle, meeting_id: MeetingId, text: String) {
    let payload = PartialPayload {
        meeting_id: meeting_id.to_string(),
        text,
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
