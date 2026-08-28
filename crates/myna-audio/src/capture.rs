//! cpal-backed microphone capture, platform system-audio capture, and the
//! mixer that combines them — all normalized to a target sample rate and
//! channel count.
//!
//! System audio has no fixed, known-ahead-of-time sample rate (see
//! [`crate::system::start_system_audio_capture`]'s docs): [`DeferredResampler`]
//! bridges the gap between "the backend started delivering raw samples" and
//! "the caller learned the actual rate to resample them at", so no audio in
//! that (typically sub-millisecond) window is lost.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{FromSample, InputCallbackInfo, Sample, SampleFormat, SizedSample, StreamConfig};
use serde::{Deserialize, Serialize};

use crate::device::{default_input_device, resolve_device, DeviceInfo};
use crate::error::AudioError;
use crate::mixer::{
    mix_into, DriftController, SampleRing, RENDERING_QUERY_MIN_INTERVAL,
    SYSTEM_RENDERING_SILENCE_TIMEOUT, SYSTEM_RING_CAPACITY, SYSTEM_STALL_TIMEOUT,
    TARGET_FILL_SAMPLES,
};
use crate::resample::{downmix_to_mono, Resampler, TARGET_SAMPLE_RATE};
use crate::system::{start_system_audio_capture, SystemAudioHandle, SystemAudioSource};

/// How long the poll loop in [`capture`] sleeps between checks of `stop`.
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Relative resample-ratio headroom given to the system-audio resampler in
/// [`capture_mixed`], so [`DriftController`]'s adjustments (bounded to
/// ±[`crate::mixer::MAX_DRIFT_ADJUST`]) have room to apply.
const SYSTEM_RESAMPLE_MAX_RELATIVE: f64 = 1.1;

/// Normalized output format `capture` delivers to its callback.
#[derive(Debug, Clone, Copy)]
pub struct CaptureConfig {
    pub sample_rate: u32,
    pub channels: u16,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        Self {
            sample_rate: 16_000,
            channels: 1,
        }
    }
}

/// Which audio source a capture session pulls from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CaptureSource {
    Microphone,
    System,
    #[default]
    Mixed,
}

/// Parameters for [`capture_sources`]: which source to capture, which device
/// to use for it (microphone only), which system-audio source to use for
/// it (system/mixed only), and the normalized output format.
pub struct CaptureRequest<'a> {
    pub source: CaptureSource,
    /// The input device to use when `source == Microphone`. `None` selects
    /// the host's default input device. Ignored when `source == System`.
    pub device: Option<&'a DeviceInfo>,
    /// The [`SystemAudioSource::id`] to capture from when `source` is
    /// `System` or `Mixed`. `None` selects all system output. Ignored when
    /// `source == Microphone`.
    pub system_source: Option<&'a str>,
    pub config: CaptureConfig,
}

/// Captures audio from `request.source`, always delivering 16 kHz mono f32
/// to `on_samples`, whatever the source's native format.
///
/// `on_system_source` is invoked once, only when `request.source` is
/// `System` or `Mixed` and the system-audio backend actually starts, with
/// the [`SystemAudioSource`] it ended up capturing — which may differ from
/// `request.system_source` if that id could no longer be resolved (see
/// [`start_system_audio_capture`]'s docs). Never invoked for
/// `CaptureSource::Microphone`.
///
/// Same blocking contract as [`capture`]: **blocks the calling thread until
/// `stop` is set to `true`.** Run this on a dedicated thread.
///
/// `CaptureSource::System` and `CaptureSource::Mixed` require a platform
/// backend (macOS only today); elsewhere they return
/// [`AudioError::SystemAudioUnavailable`].
pub fn capture_sources(
    request: &CaptureRequest<'_>,
    stop: Arc<AtomicBool>,
    on_samples: impl FnMut(&[f32]) + Send + 'static,
    on_system_source: impl FnMut(SystemAudioSource) + Send + 'static,
) -> Result<(), AudioError> {
    match request.source {
        CaptureSource::Microphone => {
            let device = resolve_request_device(request.device)?;
            capture_microphone(&device, &request.config, stop, on_samples)
        }
        CaptureSource::System => {
            capture_system_only(request.system_source, stop, on_samples, on_system_source)
        }
        CaptureSource::Mixed => {
            let device = resolve_request_device(request.device)?;
            capture_mixed(
                &device,
                &request.config,
                request.system_source,
                stop,
                on_samples,
                on_system_source,
            )
        }
    }
}

/// Resolves the device to capture from: the explicit device if given,
/// otherwise the host's default input device.
///
/// Shared by the `Microphone` and `Mixed` branches of [`capture_sources`];
/// `System` never touches an input device.
fn resolve_request_device(explicit: Option<&DeviceInfo>) -> Result<DeviceInfo, AudioError> {
    match explicit {
        Some(device) => Ok(device.clone()),
        None => default_input_device(),
    }
}

/// Captures audio from `device`, downmixing and resampling it to
/// `config.sample_rate` / `config.channels`, and invokes `on_samples` with
/// each normalized block of interleaved f32 samples.
///
/// Only mono (`config.channels == 1`) output is resampled today; the source
/// stream is always downmixed to mono before resampling, matching every
/// downstream consumer (`myna-stt`, VAD) in this codebase.
///
/// **Blocks the calling thread until `stop` is set to `true`.** Run this on
/// a dedicated thread — it opens a cpal stream and then parks the caller in
/// a poll loop for the stream's lifetime.
pub fn capture(
    device: &DeviceInfo,
    config: &CaptureConfig,
    stop: Arc<AtomicBool>,
    on_samples: impl FnMut(&[f32]) + Send + 'static,
) -> Result<(), AudioError> {
    let request = CaptureRequest {
        source: CaptureSource::Microphone,
        device: Some(device),
        system_source: None,
        config: *config,
    };
    // The `Microphone` branch of `capture_sources` never invokes
    // `on_system_source`, so this no-op is never called — it only exists to
    // satisfy the signature, keeping `capture`'s own signature (this
    // function) unchanged for its callers (`myna-stt`, the CLI).
    capture_sources(&request, stop, on_samples, |_source: SystemAudioSource| {})
}

/// Captures microphone audio from `device`. This is the implementation
/// behind both [`capture`] and the `Microphone` branch of
/// [`capture_sources`].
fn capture_microphone(
    device: &DeviceInfo,
    config: &CaptureConfig,
    stop: Arc<AtomicBool>,
    on_samples: impl FnMut(&[f32]) + Send + 'static,
) -> Result<(), AudioError> {
    let (stream, pipeline) = open_microphone_stream(device, config, on_samples)?;

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(POLL_INTERVAL);
    }

    drop(stream);
    if let Ok(mut pipeline) = pipeline.lock() {
        pipeline.flush_tail();
    }

    Ok(())
}

/// Shared, lockable handle to a microphone [`Pipeline`]. Named to keep
/// [`open_microphone_stream`]'s return type from tripping
/// `clippy::type_complexity`.
type SharedPipeline<F> = Arc<Mutex<Pipeline<F>>>;

/// Opens a cpal input stream on `device`, downmixing and resampling every
/// captured block to `config.sample_rate` mono before invoking `on_block`.
///
/// Returns the live (already playing) stream together with the pipeline
/// handle, so callers control exactly when the stream stops and when the
/// resampler's tail is flushed. [`capture_mixed`] needs that control: it
/// must drain the system-audio ring before flushing the mic tail.
fn open_microphone_stream<F>(
    device: &DeviceInfo,
    config: &CaptureConfig,
    on_block: F,
) -> Result<(cpal::Stream, SharedPipeline<F>), AudioError>
where
    F: FnMut(&[f32]) + Send + 'static,
{
    let cpal_device = resolve_device(device)?;
    let supported = cpal_device
        .default_input_config()
        .map_err(|err| AudioError::UnsupportedFormat(err.to_string()))?;

    let sample_format = supported.sample_format();
    let source_channels = supported.channels();
    let source_rate = supported.sample_rate().0;
    let stream_config: StreamConfig = supported.into();

    let pipeline = Pipeline::new(source_channels, source_rate, config, on_block)?;
    let pipeline = Arc::new(Mutex::new(pipeline));

    let stream = build_stream(
        &cpal_device,
        &stream_config,
        sample_format,
        Arc::clone(&pipeline),
    )?;
    stream
        .play()
        .map_err(|err| AudioError::Stream(err.to_string()))?;

    Ok((stream, pipeline))
}

/// Captures system audio only: the platform backend drives `on_samples`
/// directly through a resample-only pipeline. There is no ring buffer or
/// drift controller here — with only one clock in play, there is nothing
/// to reconcile against.
///
/// The backend's actual sample rate is only known once
/// [`start_system_audio_capture`] returns, so the raw callback registered
/// with it pushes through a [`DeferredResampler`] rather than a plain
/// [`Resampler`] built ahead of time — see this module's docs.
fn capture_system_only(
    system_source: Option<&str>,
    stop: Arc<AtomicBool>,
    on_samples: impl FnMut(&[f32]) + Send + 'static,
    mut on_system_source: impl FnMut(SystemAudioSource) + Send + 'static,
) -> Result<(), AudioError> {
    let resampler = Arc::new(Mutex::new(DeferredResampler::pending()));
    let sink = Arc::new(Mutex::new(on_samples));

    let resampler_for_callback = Arc::clone(&resampler);
    let sink_for_callback = Arc::clone(&sink);
    let (capture, effective_source, actual_rate) =
        start_system_audio_capture(system_source, move |raw: &[f32]| {
            let resampled = match resampler_for_callback.lock() {
                Ok(mut resampler) => resampler.push_raw(raw),
                Err(_) => return,
            };
            let Some(resampled) = resampled.filter(|block| !block.is_empty()) else {
                return;
            };
            if let Ok(mut sink) = sink_for_callback.lock() {
                (sink)(&resampled);
            }
        })?;
    on_system_source(effective_source);

    let built = Resampler::new_adjustable(
        actual_rate,
        TARGET_SAMPLE_RATE,
        SYSTEM_RESAMPLE_MAX_RELATIVE,
    )?;
    let initial_output = resampler
        .lock()
        .map(|mut slot| slot.finalize(built))
        .unwrap_or_default();
    if !initial_output.is_empty() {
        if let Ok(mut sink) = sink.lock() {
            (sink)(&initial_output);
        }
    }

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(POLL_INTERVAL);
    }

    capture.stop()?;
    let tail = resampler
        .lock()
        .map(|mut slot| slot.flush())
        .unwrap_or_default();
    if !tail.is_empty() {
        if let Ok(mut sink) = sink.lock() {
            (sink)(&tail);
        }
    }

    Ok(())
}

/// Bridges [`start_system_audio_capture`]'s actual sample rate — known only
/// once it returns — to raw native-rate samples the platform backend may
/// already be delivering by then. Buffers those samples while `Pending`,
/// then resamples everything buffered, in arrival order, the moment
/// [`DeferredResampler::finalize`] switches it to `Ready` — so no audio
/// between "the backend started" and "the caller learned the rate" is ever
/// lost, whichever happens to arrive first.
enum DeferredResampler {
    Pending(Vec<f32>),
    Ready(Resampler),
}

impl DeferredResampler {
    fn pending() -> Self {
        Self::Pending(Vec::new())
    }

    /// Feeds a raw native-rate block from the backend's callback thread.
    /// Returns resampled output ready to forward downstream, or `None`
    /// while still buffering ahead of [`DeferredResampler::finalize`].
    fn push_raw(&mut self, raw: &[f32]) -> Option<Vec<f32>> {
        match self {
            Self::Pending(buffered) => {
                buffered.extend_from_slice(raw);
                None
            }
            Self::Ready(resampler) => Some(resampler.process(raw)),
        }
    }

    /// Adjusts the wrapped resampler's ratio once `Ready`; a no-op while
    /// still `Pending` — there is nothing running yet to adjust.
    fn set_ratio_relative(&mut self, relative: f64) {
        if let Self::Ready(resampler) = self {
            let _ = resampler.set_ratio_relative(relative);
        }
    }

    /// Called once, on the calling thread, immediately after the actual
    /// sample rate becomes known. Switches to `Ready` and resamples
    /// anything buffered while racing the backend's first callback(s).
    fn finalize(&mut self, mut resampler: Resampler) -> Vec<f32> {
        let buffered = match std::mem::replace(self, Self::Pending(Vec::new())) {
            Self::Pending(buffered) => buffered,
            Self::Ready(_) => Vec::new(),
        };
        let output = if buffered.is_empty() {
            Vec::new()
        } else {
            resampler.process(&buffered)
        };
        *self = Self::Ready(resampler);
        output
    }

    /// Drains and resamples any samples still buffered internally. Mirrors
    /// [`Resampler::flush`]; a no-op while still `Pending`.
    fn flush(&mut self) -> Vec<f32> {
        match self {
            Self::Pending(_) => Vec::new(),
            Self::Ready(resampler) => resampler.flush(),
        }
    }
}

/// Captures microphone and system audio together, mixed sample-for-sample.
///
/// The microphone is the master clock: every mic block pulls the same
/// number of samples out of a [`SampleRing`] fed by the system-audio
/// backend, mixes the two via [`mix_into`], and forwards the result. A
/// [`DriftController`] watches the ring's fill level and nudges the
/// system-audio resampler's ratio to keep the two streams from drifting
/// apart over time — there is no shared clock between them, so fill-level
/// control is the whole strategy (see `crate::mixer`'s module docs).
fn capture_mixed(
    device: &DeviceInfo,
    config: &CaptureConfig,
    system_source: Option<&str>,
    stop: Arc<AtomicBool>,
    on_samples: impl FnMut(&[f32]) + Send + 'static,
    on_system_source: impl FnMut(SystemAudioSource) + Send + 'static,
) -> Result<(), AudioError> {
    capture_mixed_inner(
        MixedCaptureParams {
            device,
            config,
            system_source,
            stop,
        },
        on_samples,
        on_system_source,
        attach_system_audio_to_ring,
        capture_microphone_boxed,
    )
}

/// Grouped capture parameters for [`capture_mixed_inner`], pulled out of its
/// argument list — mirroring `session.rs`'s `CaptureSelection` — to keep its
/// arity within clippy's `too_many_arguments` limit.
struct MixedCaptureParams<'a> {
    device: &'a DeviceInfo,
    config: &'a CaptureConfig,
    system_source: Option<&'a str>,
    stop: Arc<AtomicBool>,
}

/// Boxed `on_samples` callback, named to keep [`capture_microphone_boxed`]
/// and [`capture_mixed_inner`]'s `MicOnly` type parameter from tripping
/// `clippy::type_complexity`.
type BoxedSampleSink = Box<dyn FnMut(&[f32]) + Send>;

/// Thin adapter so [`capture_microphone`] can serve as
/// [`capture_mixed_inner`]'s mic-only fallback, whose `MicOnly` type
/// parameter is fixed to one concrete boxed-callback signature shared by
/// both this production call and any fake substituted in tests.
fn capture_microphone_boxed(
    device: &DeviceInfo,
    config: &CaptureConfig,
    stop: Arc<AtomicBool>,
    on_samples: BoxedSampleSink,
) -> Result<(), AudioError> {
    capture_microphone(device, config, stop, on_samples)
}

/// [`capture_mixed`]'s implementation, generic over the system-audio attach
/// step (`attach`) and the mic-only fallback step (`mic_only`) so both can
/// be swapped for fakes in tests without ever touching real Core Audio or
/// cpal — see this module's `tests` submodule for the regression test
/// proving a failed attach degrades to microphone-only rather than
/// propagating the error and refusing to record at all.
fn capture_mixed_inner<Attach, MicOnly>(
    params: MixedCaptureParams<'_>,
    on_samples: impl FnMut(&[f32]) + Send + 'static,
    mut on_system_source: impl FnMut(SystemAudioSource) + Send + 'static,
    attach: Attach,
    mic_only: MicOnly,
) -> Result<(), AudioError>
where
    Attach: FnOnce(
        Option<&str>,
        &Arc<SampleRing>,
        &Arc<Mutex<DeferredResampler>>,
        &Arc<Mutex<Instant>>,
        &Arc<Mutex<Instant>>,
    ) -> Result<AttachedSystemAudio, AudioError>,
    MicOnly: FnOnce(
        &DeviceInfo,
        &CaptureConfig,
        Arc<AtomicBool>,
        BoxedSampleSink,
    ) -> Result<(), AudioError>,
{
    let MixedCaptureParams {
        device,
        config,
        system_source,
        stop,
    } = params;

    let ring = Arc::new(SampleRing::new(SYSTEM_RING_CAPACITY, TARGET_FILL_SAMPLES));
    let resampler = Arc::new(Mutex::new(DeferredResampler::pending()));
    let last_activity = Arc::new(Mutex::new(Instant::now()));
    let last_nonzero_activity = Arc::new(Mutex::new(Instant::now()));

    let attached = match attach(
        system_source,
        &ring,
        &resampler,
        &last_activity,
        &last_nonzero_activity,
    ) {
        Ok(attached) => attached,
        Err(err) => {
            // A meeting recorder that captures mic-only beats one that
            // refuses to record over a transient tap failure — mirrors the
            // same policy `session.rs`'s `resolve_capture_source` applies
            // to the initial source selection. `on_system_source` is
            // deliberately not called: no system source attached, so its
            // absence already tells the truth about what's being recorded.
            eprintln!(
                "myna-audio: system-audio attach failed ({err}); continuing \
                 microphone-only for this recording"
            );
            return mic_only(device, config, stop, Box::new(on_samples));
        }
    };
    on_system_source(attached.effective_source);

    let system_source_owned = system_source.map(str::to_string);
    let handle = Arc::new(Mutex::new(Some(attached.handle)));
    let rebuilding = Arc::new(AtomicBool::new(false));

    let mixer = Arc::new(Mutex::new(MixState {
        ring: Arc::clone(&ring),
        resampler: Arc::clone(&resampler),
        last_activity: Arc::clone(&last_activity),
        last_nonzero_activity: Arc::clone(&last_nonzero_activity),
        handle: Arc::clone(&handle),
        rebuilding: Arc::clone(&rebuilding),
        system_source: system_source_owned,
        drift: DriftController::new(TARGET_FILL_SAMPLES),
        last_adjustment: 0.0,
        stalled: false,
        rendering_query: RateLimitedQuery::new(RENDERING_QUERY_MIN_INTERVAL),
        on_samples,
    }));
    let mixer_for_mic = Arc::clone(&mixer);

    let mic_stream = open_microphone_stream(device, config, move |mic_block: &[f32]| {
        if let Ok(mut mixer) = mixer_for_mic.lock() {
            mixer.handle_mic_block(mic_block);
        }
    });

    let (stream, pipeline) = match mic_stream {
        Ok(pair) => pair,
        Err(err) => {
            let _ = stop_system_audio_handle(&handle);
            return Err(err);
        }
    };

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(POLL_INTERVAL);
    }

    drop(stream);
    // A stall-recovery rebuild may be mid-flight (see `MixState::trigger_rebuild`);
    // wait for it to finish so the handle it installs isn't stopped out from
    // under it, and so the handle taken below is always the current one.
    while rebuilding.load(Ordering::Acquire) {
        std::thread::sleep(POLL_INTERVAL);
    }
    stop_system_audio_handle(&handle)?;
    // Drain any system audio still buffered before flushing the mic
    // resampler's tail, so the WAV ends on the mic's true tail rather than
    // stale leftover system audio appended after it.
    if let Ok(mut mixer) = mixer.lock() {
        mixer.drain_ring_remainder();
    }
    if let Ok(mut pipeline) = pipeline.lock() {
        pipeline.flush_tail();
    }

    Ok(())
}

/// Result of (re)attaching the system-audio backend to a [`SampleRing`]:
/// [`attach_system_audio_to_ring`]'s return value.
struct AttachedSystemAudio {
    handle: SystemAudioHandle,
    effective_source: SystemAudioSource,
}

/// Starts the system-audio backend and wires its raw callback straight into
/// `ring`, via `resampler` — resetting `resampler` to a fresh, `Pending`
/// state first, since any state left over from a previous attach (e.g. a
/// stall-recovery rebuild) is stale. Shared by `capture_mixed`'s initial
/// start and [`MixState::trigger_rebuild`]'s teardown-and-recreate.
///
/// Resets `last_activity` and `last_nonzero_activity` to "now" once the
/// resampler is finalized, so a rebuild doesn't immediately look stalled
/// again before its first real callback arrives.
fn attach_system_audio_to_ring(
    system_source: Option<&str>,
    ring: &Arc<SampleRing>,
    resampler: &Arc<Mutex<DeferredResampler>>,
    last_activity: &Arc<Mutex<Instant>>,
    last_nonzero_activity: &Arc<Mutex<Instant>>,
) -> Result<AttachedSystemAudio, AudioError> {
    if let Ok(mut slot) = resampler.lock() {
        *slot = DeferredResampler::pending();
    }

    let ring_for_callback = Arc::clone(ring);
    let resampler_for_callback = Arc::clone(resampler);
    let last_activity_for_callback = Arc::clone(last_activity);
    let last_nonzero_for_callback = Arc::clone(last_nonzero_activity);
    let (handle, effective_source, actual_rate) =
        start_system_audio_capture(system_source, move |raw: &[f32]| {
            if let Ok(mut last) = last_activity_for_callback.lock() {
                *last = Instant::now();
            }
            if raw.iter().any(|&sample| sample != 0.0) {
                if let Ok(mut last) = last_nonzero_for_callback.lock() {
                    *last = Instant::now();
                }
            }
            let resampled = match resampler_for_callback.lock() {
                Ok(mut resampler) => resampler.push_raw(raw),
                Err(_) => return,
            };
            if let Some(resampled) = resampled.filter(|block| !block.is_empty()) {
                ring_for_callback.push(&resampled);
            }
        })?;

    let built = Resampler::new_adjustable(
        actual_rate,
        TARGET_SAMPLE_RATE,
        SYSTEM_RESAMPLE_MAX_RELATIVE,
    )?;
    let initial_output = resampler
        .lock()
        .map(|mut slot| slot.finalize(built))
        .unwrap_or_default();
    if !initial_output.is_empty() {
        ring.push(&initial_output);
    }
    let now = Instant::now();
    if let Ok(mut last) = last_activity.lock() {
        *last = now;
    }
    if let Ok(mut last) = last_nonzero_activity.lock() {
        *last = now;
    }

    Ok(AttachedSystemAudio {
        handle,
        effective_source,
    })
}

/// Takes and stops whatever [`SystemAudioHandle`] currently occupies `slot`,
/// if any — a no-op if a stall-recovery rebuild has already taken it (or
/// never installed one).
fn stop_system_audio_handle(
    slot: &Arc<Mutex<Option<SystemAudioHandle>>>,
) -> Result<(), AudioError> {
    let handle = slot.lock().ok().and_then(|mut guard| guard.take());
    match handle {
        Some(handle) => handle.stop(),
        None => Ok(()),
    }
}

/// Pure decision extracted from [`MixState::update_stall_state`] so the
/// stall policy is unit-testable without a real Core Audio device or HAL
/// round-trip: given how long it's been since the last system-audio
/// callback at all, how long it's been since the last *non-zero* callback,
/// and whether the tapped process(es) are (a rate-limited, cached read of)
/// currently reporting an active output session, decides whether the
/// system-audio source should be treated as stalled.
///
/// Two independent triggers, deliberately using two different timeouts:
/// - `since_last_callback > `[`SYSTEM_STALL_TIMEOUT`] — the tap has gone
///   fully silent at the IOProc level (died outright). Cheap and fast.
/// - `since_last_nonzero > `[`SYSTEM_RENDERING_SILENCE_TIMEOUT`] *and*
///   `is_rendering` — buffers have been all-zero for much longer than an
///   ordinary conversational pause, while the tapped process still reports
///   an active output session. `is_rendering` alone (over the short
///   [`SYSTEM_STALL_TIMEOUT`] window) can't distinguish this from a
///   genuinely quiet room — see [`SYSTEM_RENDERING_SILENCE_TIMEOUT`]'s doc
///   comment for why that timeout must be much longer.
pub fn is_system_audio_stalled(
    since_last_callback: Duration,
    since_last_nonzero: Duration,
    is_rendering: bool,
) -> bool {
    let no_callback_stalled = since_last_callback > SYSTEM_STALL_TIMEOUT;
    let silent_while_rendering =
        since_last_nonzero > SYSTEM_RENDERING_SILENCE_TIMEOUT && is_rendering;
    no_callback_stalled || silent_while_rendering
}

/// Rate-limits a boolean query — e.g. a Core Audio HAL round-trip — to at
/// most once per `min_interval`, returning the cached result from the most
/// recent refresh in between.
///
/// Time is injected via an `Instant` parameter (rather than read from the
/// system clock) so this is unit-testable without sleeping.
pub struct RateLimitedQuery {
    min_interval: Duration,
    last_refreshed_at: Option<Instant>,
    cached: bool,
}

impl RateLimitedQuery {
    /// Builds a query cache that refreshes at most once per `min_interval`.
    /// Reports `false` until the first [`RateLimitedQuery::get`] call.
    pub fn new(min_interval: Duration) -> Self {
        Self {
            min_interval,
            last_refreshed_at: None,
            cached: false,
        }
    }

    /// Returns the cached value, first calling `query` to refresh it if
    /// this is the first call or at least `min_interval` has elapsed since
    /// the last refresh. `query` is never called more often than that,
    /// regardless of how often `get` itself is called.
    pub fn get(&mut self, now: Instant, query: impl FnOnce() -> bool) -> bool {
        let stale = match self.last_refreshed_at {
            None => true,
            Some(last) => now.duration_since(last) >= self.min_interval,
        };
        if stale {
            self.cached = query();
            self.last_refreshed_at = Some(now);
        }
        self.cached
    }
}

/// Mixer state driven from the mic capture callback: pops system audio out
/// of the ring, mixes it with each mic block, watches for a stalled
/// system-audio source, and steers the system resampler's ratio via
/// [`DriftController`].
struct MixState<F: FnMut(&[f32]) + Send + 'static> {
    ring: Arc<SampleRing>,
    resampler: Arc<Mutex<DeferredResampler>>,
    last_activity: Arc<Mutex<Instant>>,
    last_nonzero_activity: Arc<Mutex<Instant>>,
    /// The live system-audio handle, shared with any in-flight stall
    /// recovery rebuild ([`Self::trigger_rebuild`]) so both sides always
    /// see (and replace) the same handle.
    handle: Arc<Mutex<Option<SystemAudioHandle>>>,
    /// Guards against triggering more than one rebuild at a time while a
    /// stall persists across many mic blocks.
    rebuilding: Arc<AtomicBool>,
    /// Owned copy of the id [`crate::capture_sources`] was asked to
    /// capture — [`Self::trigger_rebuild`] needs to re-resolve and restart
    /// capture from a spawned thread, which can't borrow the `&str` the
    /// original call was given.
    system_source: Option<String>,
    drift: DriftController,
    last_adjustment: f64,
    stalled: bool,
    /// Rate-limited, cached read of
    /// [`SystemAudioHandle::is_any_tapped_process_rendering_output`] — see
    /// [`RENDERING_QUERY_MIN_INTERVAL`] for why this is never queried more
    /// than once per second.
    rendering_query: RateLimitedQuery,
    on_samples: F,
}

impl<F: FnMut(&[f32]) + Send + 'static> MixState<F> {
    fn handle_mic_block(&mut self, mic_block: &[f32]) {
        self.update_stall_state();

        let system_block = self.ring.pop_into(mic_block.len());
        let mut mixed = vec![0.0_f32; mic_block.len()];
        mix_into(mic_block, &system_block, &mut mixed);
        (self.on_samples)(&mixed);

        self.drift.observe(self.ring.len(), Instant::now());
        let adjustment = self.drift.adjustment();
        if (adjustment - self.last_adjustment).abs() > f64::EPSILON {
            if let Ok(mut resampler) = self.resampler.lock() {
                resampler.set_ratio_relative(adjustment);
            }
            self.last_adjustment = adjustment;
        }
    }

    /// Detects a stalled system-audio source two ways: no callback at all
    /// for [`SYSTEM_STALL_TIMEOUT`] (cheap, and still sufficient if the tap
    /// dies outright), or — new for Core Audio process taps, which keep
    /// their IOProc firing on schedule even while delivering only silence —
    /// buffers that have been all-zero for [`SYSTEM_STALL_TIMEOUT`] *while*
    /// [`SystemAudioHandle::is_any_tapped_process_rendering_output`] still
    /// reports the tapped process(es) as actively rendering output. Buffer
    /// content alone can't distinguish that second case from a genuinely
    /// quiet room; the rendering-output check can.
    ///
    /// A rising edge into "stalled" triggers a full tap + aggregate
    /// teardown and rebuild ([`Self::trigger_rebuild`]) — restarting only
    /// the IOProc does not recover a stalled Core Audio tap.
    fn update_stall_state(&mut self) {
        let now = Instant::now();
        let since_last_callback = self
            .last_activity
            .lock()
            .map(|last| now.duration_since(*last))
            .unwrap_or(Duration::ZERO);
        let since_last_nonzero = self
            .last_nonzero_activity
            .lock()
            .map(|last| now.duration_since(*last))
            .unwrap_or(Duration::ZERO);

        // The rendering-output HAL query is only even considered once
        // silence has persisted well past an ordinary conversational pause
        // (`SYSTEM_RENDERING_SILENCE_TIMEOUT`), and even then it's
        // rate-limited/cached via `rendering_query` — so it never runs on
        // every mic realtime callback. See `is_system_audio_stalled`'s doc
        // comment for the two-timeout policy this implements.
        let is_rendering = since_last_nonzero > SYSTEM_RENDERING_SILENCE_TIMEOUT
            && self
                .rendering_query
                .get(now, || Self::query_rendering_output(&self.handle));
        let is_stalled =
            is_system_audio_stalled(since_last_callback, since_last_nonzero, is_rendering);

        if is_stalled == self.stalled {
            return;
        }
        self.stalled = is_stalled;

        if is_stalled {
            self.drift.freeze();
            eprintln!(
                "myna-audio: system-audio source stalled (no callback for \
                 {since_last_callback:?}, silent for {since_last_nonzero:?} while its \
                 process reports rendering output: {is_rendering}); rebuilding \
                 the system-audio tap"
            );
            self.trigger_rebuild();
        } else {
            self.ring.clear_to(TARGET_FILL_SAMPLES);
            self.drift.unfreeze();
        }
    }

    /// Reads whether any currently-tapped process reports an active output
    /// session. A HAL property round-trip (potentially Mach IPC to
    /// `coreaudiod`) — always go through `self.rendering_query` rather than
    /// calling this directly, so real callers stay rate-limited.
    fn query_rendering_output(handle: &Arc<Mutex<Option<SystemAudioHandle>>>) -> bool {
        handle
            .lock()
            .ok()
            .and_then(|guard| {
                guard
                    .as_ref()
                    .map(SystemAudioHandle::is_any_tapped_process_rendering_output)
            })
            .unwrap_or(false)
    }

    /// Tears down and recreates the whole system-audio pipeline — tap,
    /// aggregate device, and resampler — on a background thread, so the
    /// realtime mic callback that calls this never blocks on it. Guarded by
    /// `self.rebuilding` so a stall spanning many mic blocks only triggers
    /// one rebuild attempt at a time; the mic thread's own
    /// [`Self::update_stall_state`] naturally observes "unstalled" on a
    /// later call once the rebuilt tap starts delivering fresh activity.
    fn trigger_rebuild(&self) {
        if self.rebuilding.swap(true, Ordering::AcqRel) {
            return;
        }

        let ring = Arc::clone(&self.ring);
        let resampler = Arc::clone(&self.resampler);
        let last_activity = Arc::clone(&self.last_activity);
        let last_nonzero_activity = Arc::clone(&self.last_nonzero_activity);
        let handle_slot = Arc::clone(&self.handle);
        let rebuilding = Arc::clone(&self.rebuilding);
        let system_source = self.system_source.clone();

        std::thread::spawn(move || {
            if let Ok(mut slot) = handle_slot.lock() {
                if let Some(old_handle) = slot.take() {
                    let _ = old_handle.stop();
                }
            }
            ring.clear_to(0);

            match attach_system_audio_to_ring(
                system_source.as_deref(),
                &ring,
                &resampler,
                &last_activity,
                &last_nonzero_activity,
            ) {
                Ok(attached) => {
                    if let Ok(mut slot) = handle_slot.lock() {
                        *slot = Some(attached.handle);
                    }
                }
                Err(err) => {
                    eprintln!(
                        "myna-audio: system-audio stall recovery failed to rebuild the \
                         tap: {err}; will retry on the next detected stall"
                    );
                }
            }
            rebuilding.store(false, Ordering::Release);
        });
    }

    /// Flushes any system audio still buffered in the ring, mixed with
    /// silence (the mic has nothing more to contribute at this point).
    /// Called once, after the mic stream stops and before its resampler's
    /// tail flush.
    fn drain_ring_remainder(&mut self) {
        let remaining = self.ring.len();
        if remaining == 0 {
            return;
        }

        let system_block = self.ring.pop_into(remaining);
        let mic_silence = vec![0.0_f32; remaining];
        let mut mixed = vec![0.0_f32; remaining];
        mix_into(&mic_silence, &system_block, &mut mixed);
        (self.on_samples)(&mixed);
    }
}

/// Owns the downmix + resample pipeline and the caller's sample callback.
struct Pipeline<F: FnMut(&[f32]) + Send + 'static> {
    source_channels: u16,
    resampler: Resampler,
    on_samples: F,
}

impl<F: FnMut(&[f32]) + Send + 'static> Pipeline<F> {
    fn new(
        source_channels: u16,
        source_rate: u32,
        config: &CaptureConfig,
        on_samples: F,
    ) -> Result<Self, AudioError> {
        let resampler = Resampler::new(source_rate, config.sample_rate)?;
        Ok(Self {
            source_channels,
            resampler,
            on_samples,
        })
    }

    fn push(&mut self, interleaved: &[f32]) {
        let mono = downmix_to_mono(interleaved, self.source_channels);
        let normalized = self.resampler.process(&mono);
        if !normalized.is_empty() {
            (self.on_samples)(&normalized);
        }
    }

    fn flush_tail(&mut self) {
        let tail = self.resampler.flush();
        if !tail.is_empty() {
            (self.on_samples)(&tail);
        }
    }
}

/// Dispatches to a concrete-sample-type stream builder for every
/// `cpal::SampleFormat` this crate supports.
fn build_stream<F>(
    device: &cpal::Device,
    stream_config: &StreamConfig,
    sample_format: SampleFormat,
    pipeline: Arc<Mutex<Pipeline<F>>>,
) -> Result<cpal::Stream, AudioError>
where
    F: FnMut(&[f32]) + Send + 'static,
{
    match sample_format {
        SampleFormat::I8 => build_typed_stream::<i8, F>(device, stream_config, pipeline),
        SampleFormat::U8 => build_typed_stream::<u8, F>(device, stream_config, pipeline),
        SampleFormat::I16 => build_typed_stream::<i16, F>(device, stream_config, pipeline),
        SampleFormat::U16 => build_typed_stream::<u16, F>(device, stream_config, pipeline),
        SampleFormat::I32 => build_typed_stream::<i32, F>(device, stream_config, pipeline),
        SampleFormat::U32 => build_typed_stream::<u32, F>(device, stream_config, pipeline),
        SampleFormat::I64 => build_typed_stream::<i64, F>(device, stream_config, pipeline),
        SampleFormat::U64 => build_typed_stream::<u64, F>(device, stream_config, pipeline),
        SampleFormat::F32 => build_typed_stream::<f32, F>(device, stream_config, pipeline),
        SampleFormat::F64 => build_typed_stream::<f64, F>(device, stream_config, pipeline),
        other => Err(AudioError::UnsupportedFormat(format!("{other:?}"))),
    }
}

/// Builds a cpal input stream for concrete sample type `T`, converting every
/// buffer to normalized f32 before handing it to the shared pipeline.
fn build_typed_stream<T, F>(
    device: &cpal::Device,
    stream_config: &StreamConfig,
    pipeline: Arc<Mutex<Pipeline<F>>>,
) -> Result<cpal::Stream, AudioError>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
    F: FnMut(&[f32]) + Send + 'static,
{
    let data_callback = move |data: &[T], _info: &InputCallbackInfo| {
        let converted: Vec<f32> = data
            .iter()
            .map(|&sample| f32::from_sample(sample))
            .collect();
        if let Ok(mut pipeline) = pipeline.lock() {
            pipeline.push(&converted);
        }
    };
    let error_callback = |err: cpal::StreamError| {
        eprintln!("myna-audio: input stream error: {err}");
    };

    device
        .build_input_stream(stream_config, data_callback, error_callback, None)
        .map_err(|err| AudioError::Stream(err.to_string()))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;

    use super::*;

    /// Regression test for the fix to a merge blocker: a failed
    /// system-audio attach (aggregate/tap creation, format read, IOProc
    /// start, or permission revoked between the app-layer pre-check and
    /// this call) used to propagate straight out of `capture_mixed` via
    /// `?`, before the microphone stream was ever opened — killing the
    /// entire recording over a transient tap failure. `capture_mixed` must
    /// instead degrade to microphone-only.
    ///
    /// Exercised through `capture_mixed_inner` with a fake `attach` that
    /// always fails and a fake `mic_only` fallback that records whether it
    /// ran — this test never touches a real Core Audio tap or cpal device.
    #[test]
    fn capture_mixed_falls_back_to_microphone_only_when_system_audio_attach_fails() {
        // Arrange
        let device = DeviceInfo {
            name: "fake-device".to_string(),
        };
        let config = CaptureConfig::default();
        let stop = Arc::new(AtomicBool::new(true));

        let mic_only_called = Arc::new(AtomicBool::new(false));
        let mic_only_called_for_fake = Arc::clone(&mic_only_called);
        let system_source_reported = Arc::new(AtomicBool::new(false));
        let system_source_reported_for_cb = Arc::clone(&system_source_reported);

        let fake_attach = |_system_source: Option<&str>,
                           _ring: &Arc<SampleRing>,
                           _resampler: &Arc<Mutex<DeferredResampler>>,
                           _last_activity: &Arc<Mutex<Instant>>,
                           _last_nonzero_activity: &Arc<Mutex<Instant>>|
         -> Result<AttachedSystemAudio, AudioError> {
            Err(AudioError::SystemAudioUnavailable(
                "fake attach failure".to_string(),
            ))
        };
        let fake_mic_only = move |_device: &DeviceInfo,
                                  _config: &CaptureConfig,
                                  _stop: Arc<AtomicBool>,
                                  _on_samples: BoxedSampleSink|
              -> Result<(), AudioError> {
            mic_only_called_for_fake.store(true, Ordering::SeqCst);
            Ok(())
        };

        // Act
        let result = capture_mixed_inner(
            MixedCaptureParams {
                device: &device,
                config: &config,
                system_source: None,
                stop,
            },
            |_samples: &[f32]| {},
            move |_source| system_source_reported_for_cb.store(true, Ordering::SeqCst),
            fake_attach,
            fake_mic_only,
        );

        // Assert
        assert!(
            result.is_ok(),
            "expected the mic-only fallback's Ok to propagate, got {result:?}"
        );
        assert!(
            mic_only_called.load(Ordering::SeqCst),
            "expected the mic-only fallback to run when attach fails"
        );
        assert!(
            !system_source_reported.load(Ordering::SeqCst),
            "on_system_source must not fire when no system source ever attached"
        );
    }
}
