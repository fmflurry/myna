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
    mix_stereo_into, ring_capacity_and_target_frames, DriftController, SampleRing,
    RENDERING_QUERY_MIN_INTERVAL, SYSTEM_RENDERING_SILENCE_TIMEOUT, SYSTEM_RING_CAPACITY,
    SYSTEM_STALL_TIMEOUT, TARGET_FILL_SAMPLES,
};
use crate::resample::{downmix_to_mono, Resampler, TARGET_SAMPLE_RATE};
use crate::system::{
    start_system_audio_capture, SystemAudioBlock, SystemAudioHandle, SystemAudioSource,
};

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

/// One block of captured audio, delivered per-track rather than pre-mixed.
///
/// Each present slice is 16 kHz mono f32, matching the normalized format
/// [`capture_sources`] has always delivered — only the summing (previously
/// done via [`crate::mix_into`] before the callback ever saw the samples)
/// has moved downstream, so consumers that need per-track audio (e.g.
/// per-speaker STT) can see it. `None` means that track contributed nothing
/// to this block: [`CaptureSource::Microphone`] never populates `system`,
/// [`CaptureSource::System`] never populates `mic`, and the tail flush after
/// the mic stream stops populates only `system`.
/// `playback` is new for Phase 2b: interleaved stereo at whichever native
/// rate this capture's system-audio tap reports (or the microphone's own
/// device rate for `CaptureSource::Microphone`, which has no tap at all) —
/// mic contribution (if any) duplicated centered to both channels, system
/// contribution (if any) with its genuine, never-downmixed L/R preserved,
/// both gained and summed per channel the same way [`crate::mix_into`]
/// gains and sums the mono equivalent (see [`crate::mixer::mix_stereo_into`]).
/// Always present (never `Option`), though it may be empty during the
/// earliest race window before a rate is known.
pub struct TrackBlock<'a> {
    pub mic: Option<&'a [f32]>,
    pub system: Option<&'a [f32]>,
    pub playback: &'a [f32],
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
/// to `on_samples` as a [`TrackBlock`] (per-track, never summed), whatever
/// the source's native format.
///
/// `on_system_source` is invoked once, only when `request.source` is
/// `System` or `Mixed` and the system-audio backend actually starts, with
/// the [`SystemAudioSource`] it ended up capturing — which may differ from
/// `request.system_source` if that id could no longer be resolved (see
/// [`start_system_audio_capture`]'s docs). Never invoked for
/// `CaptureSource::Microphone`.
///
/// `on_native_rate` is invoked exactly once, for every source, with the
/// authoritative sample rate `TrackBlock::playback` is (and stays) sized at
/// for the rest of this capture — the microphone's own device rate for
/// `CaptureSource::Microphone` (and for `Mixed`'s automatic mic-only
/// fallback when the system-audio attach fails), or the system-audio tap's
/// pinned native rate for `CaptureSource::System` and `Mixed`'s happy path
/// (see [`AttachedSystemAudio::actual_rate`] — a stall-recovery rebuild that
/// would change it is rejected outright, so the rate reported here is
/// stable for the whole recording). Always called strictly before the first
/// `playback` block that could ever be non-empty — never raced against it —
/// so a caller can safely defer creating a rate-stamped resource (e.g. a WAV
/// header) until this fires. Not invoked at all if capture fails before a
/// rate could ever be resolved (the `?` below propagates instead).
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
    mut on_samples: impl FnMut(&TrackBlock<'_>) + Send + 'static,
    on_system_source: impl FnMut(SystemAudioSource) + Send + 'static,
    on_native_rate: impl FnOnce(u32) + Send + 'static,
) -> Result<(), AudioError> {
    match request.source {
        CaptureSource::Microphone => {
            let device = resolve_request_device(request.device)?;
            capture_microphone_with_playback(
                &device,
                &request.config,
                stop,
                on_native_rate,
                move |mic: &[f32], playback: &[f32]| {
                    on_samples(&TrackBlock {
                        mic: Some(mic),
                        system: None,
                        playback,
                    });
                },
            )
        }
        CaptureSource::System => capture_system_only(
            request.system_source,
            stop,
            on_samples,
            on_system_source,
            on_native_rate,
        ),
        CaptureSource::Mixed => {
            let device = resolve_request_device(request.device)?;
            capture_mixed(
                &device,
                &request.config,
                request.system_source,
                stop,
                on_samples,
                on_system_source,
                on_native_rate,
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
    mut on_samples: impl FnMut(&[f32]) + Send + 'static,
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
    // function) unchanged for its callers (`myna-stt`, the CLI). Likewise
    // `capture_sources` now delivers a `TrackBlock`, but the `Microphone`
    // branch always populates `mic` and never `system`, so unwrapping it
    // back to a plain mono slice here keeps this function's own signature
    // (and every caller's) unchanged.
    capture_sources(
        &request,
        stop,
        move |block: &TrackBlock<'_>| {
            if let Some(mic) = block.mic {
                on_samples(mic);
            }
        },
        |_source: SystemAudioSource| {},
        |_rate: u32| {},
    )
}

/// Captures microphone audio from `device`. This is the implementation
/// behind both [`capture`] and the `Microphone` branch of
/// [`capture_sources`].
///
/// `on_samples` is invoked as `(native_mono, resampled_16k_mono)`:
/// `native_mono` is the native-rate mono [`Pipeline`] downmixed just before
/// resampling — everything accumulated since the last emission, handed off
/// then cleared (see [`Pipeline::push`]) — and `resampled_16k_mono` is the
/// usual 16kHz mono STT feed, byte-identical to what this function produced
/// before `native_mono` existed. Only invoked when `resampled_16k_mono` is
/// non-empty, exactly as before.
fn capture_microphone(
    device: &DeviceInfo,
    config: &CaptureConfig,
    stop: Arc<AtomicBool>,
    on_native_rate: impl FnOnce(u32) + Send + 'static,
    on_samples: impl FnMut(&[f32], &[f32]) + Send + 'static,
) -> Result<(), AudioError> {
    let (stream, pipeline) = open_microphone_stream(device, config, on_native_rate, on_samples)?;

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(POLL_INTERVAL);
    }

    drop(stream);
    if let Ok(mut pipeline) = pipeline.lock() {
        pipeline.flush_tail();
    }

    Ok(())
}

/// Captures microphone-only audio like [`capture_microphone`], additionally
/// deriving a native-rate stereo `playback` track (mic duplicated centered
/// to both channels, see [`mix_stereo_into`]) for [`capture_sources`]'s
/// `CaptureSource::Microphone` branch, and for `Mixed`'s automatic
/// mic-only fallback when the system-audio attach fails (see
/// `capture_mixed_inner`). "Native rate" here is the microphone's own
/// device rate — there is no system-audio tap in this mode to take a
/// native rate from instead.
///
/// Reuses [`capture_microphone`]'s existing 16kHz mono `mic` output
/// unchanged, alongside the genuine native-rate mono [`Pipeline`] hands off
/// *before* downsampling it — no second resample pass reconstructs
/// `playback` from the already-band-limited 16kHz feed (that used to be a
/// `MicNativeUpsampler` type's job; deleted, see this module's docs on why
/// heavy work in the audio callback is a regression class of its own).
fn capture_microphone_with_playback(
    device: &DeviceInfo,
    config: &CaptureConfig,
    stop: Arc<AtomicBool>,
    on_native_rate: impl FnOnce(u32) + Send + 'static,
    mut on_block: impl FnMut(&[f32], &[f32]) + Send + 'static,
) -> Result<(), AudioError> {
    let mut playback_scratch: Vec<f32> = Vec::new();

    capture_microphone(
        device,
        config,
        stop,
        on_native_rate,
        move |native_mono: &[f32], mic: &[f32]| {
            playback_scratch.clear();
            playback_scratch.resize(native_mono.len() * 2, 0.0);
            mix_stereo_into(Some(native_mono), None, &mut playback_scratch);
            on_block(mic, &playback_scratch);
        },
    )
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
    on_native_rate: impl FnOnce(u32) + Send + 'static,
    on_block: F,
) -> Result<(cpal::Stream, SharedPipeline<F>), AudioError>
where
    F: FnMut(&[f32], &[f32]) + Send + 'static,
{
    let cpal_device = resolve_device(device)?;
    let supported = cpal_device
        .default_input_config()
        .map_err(|err| AudioError::UnsupportedFormat(err.to_string()))?;

    let sample_format = supported.sample_format();
    let source_channels = supported.channels();
    let source_rate = supported.sample_rate().0;
    let stream_config: StreamConfig = supported.into();

    // Reported strictly before the stream is started (`.play()` below), so
    // this can never race the first callback — the caller's rate-stamped
    // resource (e.g. a WAV header) is always safe to build the moment this
    // returns control, without any possibility of a block having already
    // arrived at a rate no one reported yet.
    on_native_rate(source_rate);

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
/// Delivers a [`TrackBlock`] built from `mono`/`stereo` (whichever is
/// non-empty; `mic` is always `None` in system-only mode) to `sink`, unless
/// both are empty — mirrors the pre-Phase-2b gating (skip entirely when
/// there's nothing to deliver) except that a callback with genuine native
/// stereo but no flushed mono chunk yet now still delivers, rather than
/// being dropped: previously (mono-only) every such callback was silently
/// skipped, which would otherwise lose native-rate playback audio between
/// mono resample chunk boundaries. `mono`'s own content, when it IS
/// delivered, is byte-identical to before this phase.
fn deliver_system_only_block(
    sink: &Arc<Mutex<impl FnMut(&TrackBlock<'_>) + Send + 'static>>,
    mono: Option<&[f32]>,
    stereo: &[f32],
) {
    if mono.is_none() && stereo.is_empty() {
        return;
    }
    if let Ok(mut sink) = sink.lock() {
        (sink)(&TrackBlock {
            mic: None,
            system: mono,
            playback: stereo,
        });
    }
}

fn capture_system_only(
    system_source: Option<&str>,
    stop: Arc<AtomicBool>,
    on_samples: impl FnMut(&TrackBlock<'_>) + Send + 'static,
    mut on_system_source: impl FnMut(SystemAudioSource) + Send + 'static,
    on_native_rate: impl FnOnce(u32) + Send + 'static,
) -> Result<(), AudioError> {
    let resampler = Arc::new(Mutex::new(DeferredResampler::pending()));
    let playback_buffer = Arc::new(Mutex::new(DeferredResampler::pending()));
    let sink = Arc::new(Mutex::new(on_samples));

    let resampler_for_callback = Arc::clone(&resampler);
    let playback_for_callback = Arc::clone(&playback_buffer);
    let sink_for_callback = Arc::clone(&sink);
    let (capture, effective_source, actual_rate) =
        start_system_audio_capture(system_source, move |block: &SystemAudioBlock<'_>| {
            let mono: Option<Vec<f32>> = match resampler_for_callback.lock() {
                Ok(mut resampler) => resampler.push_raw(block.mono),
                Err(_) => return,
            }
            .filter(|samples| !samples.is_empty());
            let stereo: Vec<f32> = match playback_for_callback.lock() {
                Ok(mut resampler) => resampler.push_raw(block.stereo),
                Err(_) => return,
            }
            .unwrap_or_default();
            deliver_system_only_block(&sink_for_callback, mono.as_deref(), &stereo);
        })?;
    on_system_source(effective_source);
    // Reported once, here, before either resampler is finalized below — the
    // raw callback above only ever buffers into a `Pending` `DeferredResampler`
    // until `finalize` runs (on this same thread, after this point), so no
    // `playback` block can have reached `on_samples` yet.
    on_native_rate(actual_rate);

    let built = Resampler::new_adjustable(
        actual_rate,
        TARGET_SAMPLE_RATE,
        SYSTEM_RESAMPLE_MAX_RELATIVE,
    )?;
    let mono_initial = resampler
        .lock()
        .map(|mut slot| slot.finalize(built))
        .unwrap_or_default();
    // A native-native identity resampler: no cross-clock drift to correct
    // in system-only mode (there is only one clock in play — see this
    // function's own module-level doc comment), so the stereo track is
    // genuinely unresampled, not merely near-native.
    let stereo_built = Resampler::new(actual_rate, actual_rate)?;
    let stereo_initial = playback_buffer
        .lock()
        .map(|mut slot| slot.finalize(stereo_built))
        .unwrap_or_default();
    deliver_system_only_block(
        &sink,
        (!mono_initial.is_empty()).then_some(mono_initial.as_slice()),
        &stereo_initial,
    );

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(POLL_INTERVAL);
    }

    capture.stop()?;
    let mono_tail = resampler
        .lock()
        .map(|mut slot| slot.flush())
        .unwrap_or_default();
    let stereo_tail = playback_buffer
        .lock()
        .map(|mut slot| slot.flush())
        .unwrap_or_default();
    deliver_system_only_block(
        &sink,
        (!mono_tail.is_empty()).then_some(mono_tail.as_slice()),
        &stereo_tail,
    );

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

/// Captures microphone and system audio together, delivered as a
/// [`TrackBlock`] per mic block rather than pre-mixed.
///
/// The microphone is the master clock: every mic block pulls the same
/// number of samples out of a [`SampleRing`] fed by the system-audio
/// backend and forwards both tracks, unsummed, to `on_samples`. A
/// [`DriftController`] watches the ring's fill level and nudges the
/// system-audio resampler's ratio to keep the two streams from drifting
/// apart over time — there is no shared clock between them, so fill-level
/// control is the whole strategy (see `crate::mixer`'s module docs).
fn capture_mixed(
    device: &DeviceInfo,
    config: &CaptureConfig,
    system_source: Option<&str>,
    stop: Arc<AtomicBool>,
    on_samples: impl FnMut(&TrackBlock<'_>) + Send + 'static,
    on_system_source: impl FnMut(SystemAudioSource) + Send + 'static,
    on_native_rate: impl FnOnce(u32) + Send + 'static,
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
        on_native_rate,
        attach_system_audio_to_ring,
        capture_microphone_with_playback_boxed,
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

/// Boxed `on_samples` callback — `(mic_16k_mono, playback_native_stereo)` —
/// named to keep [`capture_microphone_with_playback_boxed`] and
/// [`capture_mixed_inner`]'s `MicOnly` type parameter from tripping
/// `clippy::type_complexity`.
type BoxedSampleSink = Box<dyn FnMut(&[f32], &[f32]) + Send>;

/// Boxed `on_native_rate` callback — mirrors [`BoxedSampleSink`], letting
/// [`capture_mixed_inner`]'s `MicOnly` type parameter carry an owned,
/// one-shot rate report through the same fixed, `dyn`-erased shape as
/// `on_samples`.
type BoxedRateSink = Box<dyn FnOnce(u32) + Send>;

/// Thin adapter so [`capture_microphone_with_playback`] can serve as
/// [`capture_mixed_inner`]'s mic-only fallback, whose `MicOnly` type
/// parameter is fixed to one concrete boxed-callback signature shared by
/// both this production call and any fake substituted in tests. Reusing
/// [`capture_microphone_with_playback`] here (rather than the plain
/// [`capture_microphone`]) is what fixes HIGH #5: the automatic
/// system-audio-attach-failure fallback now derives genuine native-rate
/// stereo `playback` audio the same way `CaptureSource::Microphone` does,
/// instead of delivering an empty `playback` slice for the whole recording.
fn capture_microphone_with_playback_boxed(
    device: &DeviceInfo,
    config: &CaptureConfig,
    stop: Arc<AtomicBool>,
    on_native_rate: BoxedRateSink,
    on_samples: BoxedSampleSink,
) -> Result<(), AudioError> {
    capture_microphone_with_playback(device, config, stop, on_native_rate, on_samples)
}

/// [`capture_mixed`]'s implementation, generic over the system-audio attach
/// step (`attach`) and the mic-only fallback step (`mic_only`) so both can
/// be swapped for fakes in tests without ever touching real Core Audio or
/// cpal — see this module's `tests` submodule for the regression test
/// proving a failed attach degrades to microphone-only rather than
/// propagating the error and refusing to record at all.
fn capture_mixed_inner<Attach, MicOnly>(
    params: MixedCaptureParams<'_>,
    mut on_samples: impl FnMut(&TrackBlock<'_>) + Send + 'static,
    mut on_system_source: impl FnMut(SystemAudioSource) + Send + 'static,
    on_native_rate: impl FnOnce(u32) + Send + 'static,
    attach: Attach,
    mic_only: MicOnly,
) -> Result<(), AudioError>
where
    Attach:
        FnOnce(Option<&str>, &SystemAudioAttachTargets) -> Result<AttachedSystemAudio, AudioError>,
    MicOnly: FnOnce(
        &DeviceInfo,
        &CaptureConfig,
        Arc<AtomicBool>,
        BoxedRateSink,
        BoxedSampleSink,
    ) -> Result<(), AudioError>,
{
    let MixedCaptureParams {
        device,
        config,
        system_source,
        stop,
    } = params;

    let targets = SystemAudioAttachTargets {
        ring: Arc::new(SampleRing::new(SYSTEM_RING_CAPACITY, TARGET_FILL_SAMPLES)),
        resampler: Arc::new(Mutex::new(DeferredResampler::pending())),
        playback_ring_slot: Arc::new(Mutex::new(None)),
        playback_resampler: Arc::new(Mutex::new(DeferredResampler::pending())),
        last_activity: Arc::new(Mutex::new(Instant::now())),
        last_nonzero_activity: Arc::new(Mutex::new(Instant::now())),
    };

    let attached = match attach(system_source, &targets) {
        Ok(attached) => attached,
        Err(err) => {
            // A meeting recorder that captures mic-only beats one that
            // refuses to record over a transient tap failure — mirrors the
            // same policy `session.rs`'s `resolve_capture_source` applies
            // to the initial source selection. `on_system_source` is
            // deliberately not called: no system source attached, so its
            // absence already tells the truth about what's being recorded.
            //
            // `playback` here is genuine native-rate mic stereo, not empty
            // (HIGH #5 fix) — `mic_only` is `capture_microphone_with_playback_boxed`
            // in production, the same derivation `CaptureSource::Microphone`
            // uses, so a downstream WAV writer can't distinguish this
            // degraded path from that one by an empty-forever `playback`.
            eprintln!(
                "myna-audio: system-audio attach failed ({err}); continuing \
                 microphone-only for this recording"
            );
            return mic_only(
                device,
                config,
                stop,
                Box::new(on_native_rate),
                Box::new(move |mic: &[f32], playback: &[f32]| {
                    on_samples(&TrackBlock {
                        mic: Some(mic),
                        system: None,
                        playback,
                    });
                }),
            );
        }
    };
    on_system_source(attached.effective_source);
    // Reported once, here, before the microphone stream (and therefore
    // `MixState::handle_mic_block`, the only place a `TrackBlock` is ever
    // delivered in this path) even opens — so no `playback` block can
    // possibly have been produced yet. `attached.actual_rate` is the rate
    // pinned for the rest of the recording: a stall-recovery rebuild that
    // negotiates a different rate is rejected outright (see
    // `rebuild_rate_is_acceptable`), never accepted silently, so this report
    // never goes stale mid-recording.
    on_native_rate(attached.actual_rate);

    let system_source_owned = system_source.map(str::to_string);
    let handle = Arc::new(Mutex::new(Some(attached.handle)));
    let rebuilding = Arc::new(AtomicBool::new(false));

    let mixer = Arc::new(Mutex::new(MixState {
        ring: Arc::clone(&targets.ring),
        resampler: Arc::clone(&targets.resampler),
        playback_ring_slot: Arc::clone(&targets.playback_ring_slot),
        playback_resampler: Arc::clone(&targets.playback_resampler),
        last_activity: Arc::clone(&targets.last_activity),
        last_nonzero_activity: Arc::clone(&targets.last_nonzero_activity),
        handle: Arc::clone(&handle),
        rebuilding: Arc::clone(&rebuilding),
        system_source: system_source_owned,
        drift: DriftController::new(TARGET_FILL_SAMPLES),
        last_adjustment: 0.0,
        stalled: false,
        rendering_query: RateLimitedQuery::new(RENDERING_QUERY_MIN_INTERVAL),
        native_mic_buffer: NativeMicBuffer::new(attached.actual_rate),
        native_rate: attached.actual_rate,
        playback_scratch: Vec::new(),
        on_samples,
    }));
    let mixer_for_mic = Arc::clone(&mixer);

    let mic_stream = open_microphone_stream(
        device,
        config,
        // The playback rate for this (happy) path is the system tap's
        // pinned `actual_rate`, already reported above — the mic's own
        // native rate is irrelevant to `playback` here, so this report is a
        // deliberate no-op.
        |_rate: u32| {},
        move |native_mono: &[f32], mic_block: &[f32]| {
            if let Ok(mut mixer) = mixer_for_mic.lock() {
                mixer.handle_mic_block(native_mono, mic_block);
            }
        },
    );

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
    /// The tap's actual native sample rate, as reported by
    /// `crate::system::start_system_audio_capture` for this attach.
    /// [`crate::capture::MixState`] keeps using the rate from the *first*
    /// successful attach for the rest of the recording, so
    /// `TrackBlock::playback`'s rate never changes mid-recording — a later
    /// stall-recovery rebuild ([`MixState::trigger_rebuild`]) that
    /// negotiates a DIFFERENT rate is rejected outright rather than
    /// assumed compatible; see [`rebuild_rate_is_acceptable`].
    actual_rate: u32,
}

/// Whether a stall-recovery rebuild's newly negotiated native rate is safe
/// to accept for the rest of the recording. [`MixState`]'s `native_rate`
/// and its playback ring are pinned from the FIRST successful attach and
/// never resized afterward (see [`playback_ring_get_or_init`]) — a rebuild
/// that reattaches at a DIFFERENT native rate (a realistic outcome on
/// macOS: an output device switch, or a Bluetooth device renegotiating —
/// exactly the conditions that can cause the stall this recovers from)
/// would otherwise feed audio at the new rate into a ring and resampler
/// every downstream consumer still assumes is at the pinned rate, producing
/// a silent, undetectable pitch/speed shift for the rest of the recording.
/// [`MixState::trigger_rebuild`] calls this and rejects (stops, does not
/// install) an incompatible rebuild rather than risk that.
fn rebuild_rate_is_acceptable(pinned_rate: u32, rebuilt_rate: u32) -> bool {
    pinned_rate == rebuilt_rate
}

/// Shared system-audio state [`attach_system_audio_to_ring`] (re)populates
/// and [`MixState::trigger_rebuild`] re-attaches into — grouped into one
/// struct so [`capture_mixed_inner`]'s `Attach` type parameter stays within
/// clippy's `too_many_arguments` limit.
struct SystemAudioAttachTargets {
    ring: Arc<SampleRing>,
    resampler: Arc<Mutex<DeferredResampler>>,
    /// `None` until the first successful attach learns the tap's native
    /// rate and sizes the ring — see [`playback_ring_get_or_init`]. A
    /// rebuild reuses whatever ring is already installed here rather than
    /// resizing it, keeping `TrackBlock::playback`'s rate fixed for the
    /// whole recording.
    playback_ring_slot: Arc<Mutex<Option<Arc<SampleRing>>>>,
    playback_resampler: Arc<Mutex<DeferredResampler>>,
    last_activity: Arc<Mutex<Instant>>,
    last_nonzero_activity: Arc<Mutex<Instant>>,
}

/// Returns the shared native-rate stereo playback ring from `slot`, sizing
/// and installing it from `actual_rate` on first use (see
/// [`ring_capacity_and_target_frames`]) and simply returning the existing
/// instance on every later call (including across a stall-recovery
/// rebuild) — so the ring's rate/sizing, once chosen, never changes for
/// the rest of a recording.
fn playback_ring_get_or_init(
    slot: &Arc<Mutex<Option<Arc<SampleRing>>>>,
    actual_rate: u32,
) -> Arc<SampleRing> {
    let mut guard = slot
        .lock()
        .expect("playback ring slot mutex is not poisoned");
    if let Some(existing) = guard.as_ref() {
        return Arc::clone(existing);
    }
    let (capacity_frames, target_frames) = ring_capacity_and_target_frames(actual_rate);
    let ring = Arc::new(SampleRing::with_frame_size(
        capacity_frames * 2,
        target_frames * 2,
        2,
    ));
    *guard = Some(Arc::clone(&ring));
    ring
}

/// Starts the system-audio backend and wires its raw callback straight into
/// `targets.ring`/`targets.playback_ring_slot`, via `targets.resampler`/
/// `targets.playback_resampler` — resetting both resamplers to a fresh,
/// `Pending` state first, since any state left over from a previous attach
/// (e.g. a stall-recovery rebuild) is stale. Shared by `capture_mixed`'s
/// initial start and [`MixState::trigger_rebuild`]'s teardown-and-recreate.
///
/// Resets `last_activity` and `last_nonzero_activity` to "now" once the
/// resamplers are finalized, so a rebuild doesn't immediately look stalled
/// again before its first real callback arrives.
fn attach_system_audio_to_ring(
    system_source: Option<&str>,
    targets: &SystemAudioAttachTargets,
) -> Result<AttachedSystemAudio, AudioError> {
    if let Ok(mut slot) = targets.resampler.lock() {
        *slot = DeferredResampler::pending();
    }
    if let Ok(mut slot) = targets.playback_resampler.lock() {
        *slot = DeferredResampler::pending();
    }

    let ring_for_callback = Arc::clone(&targets.ring);
    let resampler_for_callback = Arc::clone(&targets.resampler);
    let playback_ring_slot_for_callback = Arc::clone(&targets.playback_ring_slot);
    let playback_resampler_for_callback = Arc::clone(&targets.playback_resampler);
    let last_activity_for_callback = Arc::clone(&targets.last_activity);
    let last_nonzero_for_callback = Arc::clone(&targets.last_nonzero_activity);
    let (handle, effective_source, actual_rate) =
        start_system_audio_capture(system_source, move |block: &SystemAudioBlock<'_>| {
            if let Ok(mut last) = last_activity_for_callback.lock() {
                *last = Instant::now();
            }
            if block.mono.iter().any(|&sample| sample != 0.0) {
                if let Ok(mut last) = last_nonzero_for_callback.lock() {
                    *last = Instant::now();
                }
            }
            let resampled = match resampler_for_callback.lock() {
                Ok(mut resampler) => resampler.push_raw(block.mono),
                Err(_) => return,
            };
            if let Some(resampled) = resampled.filter(|block| !block.is_empty()) {
                ring_for_callback.push(&resampled);
            }

            // Independent of the mono branch above — neither is derived
            // from the other. Silently drops a chunk if the playback ring
            // hasn't been installed into the slot yet (only possible
            // during the brief pending window before `finalize` below
            // runs); this mirrors `SampleRing`'s own tolerance for
            // transient gaps elsewhere in this pipeline.
            let stereo_resampled = match playback_resampler_for_callback.lock() {
                Ok(mut resampler) => resampler.push_raw(block.stereo),
                Err(_) => return,
            };
            if let Some(stereo_resampled) = stereo_resampled.filter(|block| !block.is_empty()) {
                if let Ok(guard) = playback_ring_slot_for_callback.lock() {
                    if let Some(ring) = guard.as_ref() {
                        ring.push(&stereo_resampled);
                    }
                }
            }
        })?;

    let built = Resampler::new_adjustable(
        actual_rate,
        TARGET_SAMPLE_RATE,
        SYSTEM_RESAMPLE_MAX_RELATIVE,
    )?;
    let initial_output = targets
        .resampler
        .lock()
        .map(|mut slot| slot.finalize(built))
        .unwrap_or_default();
    if !initial_output.is_empty() {
        targets.ring.push(&initial_output);
    }

    // Install the (possibly newly-sized) playback ring *before* finalizing
    // the playback resampler: only after finalize does the raw callback's
    // `push_raw` ever return `Some`, so by the time it could, the ring is
    // already in the slot.
    let playback_ring = playback_ring_get_or_init(&targets.playback_ring_slot, actual_rate);
    let stereo_built = Resampler::new_adjustable_stereo(actual_rate, SYSTEM_RESAMPLE_MAX_RELATIVE)?;
    let stereo_initial = targets
        .playback_resampler
        .lock()
        .map(|mut slot| slot.finalize(stereo_built))
        .unwrap_or_default();
    if !stereo_initial.is_empty() {
        playback_ring.push(&stereo_initial);
    }

    let now = Instant::now();
    if let Ok(mut last) = targets.last_activity.lock() {
        *last = now;
    }
    if let Ok(mut last) = targets.last_nonzero_activity.lock() {
        *last = now;
    }

    Ok(AttachedSystemAudio {
        handle,
        effective_source,
        actual_rate,
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
/// of the ring, pairs it with each mic block into a [`TrackBlock`] (without
/// summing `mic`/`system`), derives the mixed-down-to-stereo `playback`
/// track (see [`mix_stereo_into`]), watches for a stalled system-audio
/// source, and steers the system resamplers' ratio via [`DriftController`].
struct MixState<F: FnMut(&TrackBlock<'_>) + Send + 'static> {
    ring: Arc<SampleRing>,
    resampler: Arc<Mutex<DeferredResampler>>,
    /// Native-rate stereo counterpart to `ring`/`resampler` — see
    /// [`SystemAudioAttachTargets`]'s fields of the same name.
    playback_ring_slot: Arc<Mutex<Option<Arc<SampleRing>>>>,
    playback_resampler: Arc<Mutex<DeferredResampler>>,
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
    /// Decouples the genuine native-rate mic mono `open_microphone_stream`'s
    /// callback hands off each call from `native_rate`'s ring-pull target
    /// for `playback` mixing. Sized once from the *first* successful
    /// attach's rate and never rebuilt, so `playback`'s rate is fixed for
    /// the whole recording — see [`AttachedSystemAudio::actual_rate`].
    native_mic_buffer: NativeMicBuffer,
    native_rate: u32,
    /// Reused across [`Self::handle_mic_block`] / [`Self::drain_ring_remainder`]
    /// so building `playback` never allocates a fresh output buffer on the
    /// mic capture's realtime callback thread.
    playback_scratch: Vec<f32>,
    on_samples: F,
}

impl<F: FnMut(&TrackBlock<'_>) + Send + 'static> MixState<F> {
    /// `native_mono` is the genuine native-rate mic mono
    /// `open_microphone_stream`'s callback hands off alongside `mic_block`
    /// (see [`Pipeline::push`]) — used to derive `playback`'s mic
    /// contribution directly, without a second resample reconstructing it
    /// from `mic_block`'s already-16kHz-bandlimited content.
    fn handle_mic_block(&mut self, native_mono: &[f32], mic_block: &[f32]) {
        self.update_stall_state();

        let system_block = self.ring.pop_into(mic_block.len());

        let native_frames_needed = native_frames_for(mic_block.len(), self.native_rate);
        let system_stereo = self
            .playback_ring_slot
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
            .map(|ring| ring.pop_into(native_frames_needed * 2))
            .unwrap_or_else(|| vec![0.0; native_frames_needed * 2]);
        let mic_native = self
            .native_mic_buffer
            .push_and_pop(native_mono, native_frames_needed);

        self.playback_scratch.clear();
        self.playback_scratch.resize(native_frames_needed * 2, 0.0);
        mix_stereo_into(
            Some(&mic_native),
            Some(&system_stereo),
            &mut self.playback_scratch,
        );

        (self.on_samples)(&TrackBlock {
            mic: Some(mic_block),
            system: Some(&system_block),
            playback: &self.playback_scratch,
        });

        self.drift.observe(self.ring.len(), Instant::now());
        let adjustment = self.drift.adjustment();
        if (adjustment - self.last_adjustment).abs() > f64::EPSILON {
            if let Ok(mut resampler) = self.resampler.lock() {
                resampler.set_ratio_relative(adjustment);
            }
            // Same adjustment applied to the stereo passthrough resampler
            // so it stays mutually in sync with the mono/STT track's own
            // `DriftController` correction — see
            // `Resampler::new_adjustable_stereo`'s doc comment. Not a
            // second, independent drift algorithm.
            if let Ok(mut playback_resampler) = self.playback_resampler.lock() {
                playback_resampler.set_ratio_relative(adjustment);
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
    ///
    /// Rejects (stops immediately, never installs) a rebuild that
    /// negotiates a DIFFERENT native rate than the one pinned at the first
    /// successful attach (`self.native_rate`) — see
    /// [`rebuild_rate_is_acceptable`]'s doc comment for why: `native_rate`
    /// and the playback ring are never resized after the first attach, so
    /// accepting a different rate here would silently desync `playback`'s
    /// pitch/speed for the rest of the recording. Rejecting degrades to
    /// system-audio-silent for the remainder of the recording rather than
    /// risk that — mic-only beats a corrupted recording, the same policy
    /// `capture_mixed_inner`'s initial-attach-failure branch already
    /// applies.
    fn trigger_rebuild(&self) {
        if self.rebuilding.swap(true, Ordering::AcqRel) {
            return;
        }

        let targets = SystemAudioAttachTargets {
            ring: Arc::clone(&self.ring),
            resampler: Arc::clone(&self.resampler),
            playback_ring_slot: Arc::clone(&self.playback_ring_slot),
            playback_resampler: Arc::clone(&self.playback_resampler),
            last_activity: Arc::clone(&self.last_activity),
            last_nonzero_activity: Arc::clone(&self.last_nonzero_activity),
        };
        let handle_slot = Arc::clone(&self.handle);
        let rebuilding = Arc::clone(&self.rebuilding);
        let system_source = self.system_source.clone();
        let pinned_native_rate = self.native_rate;

        std::thread::spawn(move || {
            if let Ok(mut slot) = handle_slot.lock() {
                if let Some(old_handle) = slot.take() {
                    let _ = old_handle.stop();
                }
            }
            targets.ring.clear_to(0);
            if let Some(playback_ring) = targets
                .playback_ring_slot
                .lock()
                .ok()
                .and_then(|guard| guard.clone())
            {
                playback_ring.clear_to(0);
            }

            match attach_system_audio_to_ring(system_source.as_deref(), &targets) {
                Ok(attached) => {
                    if rebuild_rate_is_acceptable(pinned_native_rate, attached.actual_rate) {
                        if let Ok(mut slot) = handle_slot.lock() {
                            *slot = Some(attached.handle);
                        }
                    } else {
                        eprintln!(
                            "myna-audio: system-audio stall recovery reattached at a \
                             different native rate ({} Hz; this recording is pinned at \
                             {} Hz from the first attach) — rejecting the rebuild to \
                             avoid an audible pitch/speed shift in `playback` for the \
                             rest of the recording; continuing without system audio",
                            attached.actual_rate, pinned_native_rate
                        );
                        let _ = attached.handle.stop();
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

    /// Flushes any system audio still buffered in the mono and playback
    /// rings (the mic has nothing more to contribute at this point, so
    /// `mic` is `None` rather than mixed against silence). Called once,
    /// after the mic stream stops and before its resampler's tail flush.
    fn drain_ring_remainder(&mut self) {
        let remaining = self.ring.len();
        let playback_ring = self
            .playback_ring_slot
            .lock()
            .ok()
            .and_then(|guard| guard.clone());
        let remaining_stereo = playback_ring.as_ref().map(|ring| ring.len()).unwrap_or(0);
        if remaining == 0 && remaining_stereo == 0 {
            return;
        }

        let system_block = self.ring.pop_into(remaining);
        let stereo_block = playback_ring
            .map(|ring| ring.pop_into(remaining_stereo))
            .unwrap_or_default();

        self.playback_scratch.clear();
        self.playback_scratch.resize(remaining_stereo, 0.0);
        mix_stereo_into(None, Some(&stereo_block), &mut self.playback_scratch);

        (self.on_samples)(&TrackBlock {
            mic: None,
            system: Some(&system_block),
            playback: &self.playback_scratch,
        });
    }
}

/// Number of native-rate frames equivalent to `mic_frames` 16kHz mono
/// frames, at `native_rate_hz` — shared by [`MixState::handle_mic_block`]
/// (sizing its system/playback ring pops) and [`NativeMicBuffer`] (sizing
/// its own pop) so both agree on exactly how many frames "this mic block's
/// worth" means at the native rate.
fn native_frames_for(mic_frames: usize, native_rate_hz: u32) -> usize {
    (mic_frames as f64 * native_rate_hz as f64 / TARGET_SAMPLE_RATE as f64).round() as usize
}

/// Decouples "native-rate mono [`Pipeline`] handed off since its last
/// emission" (see [`Pipeline::push`]) from "exactly how many native frames
/// this mic block's stereo mixing needs" ([`native_frames_for`], driven by
/// the *system*-audio side's own ring-pull target in
/// [`MixState::handle_mic_block`]) — the two rarely match exactly, since
/// the mono→16kHz resampler's internal chunking doesn't line up 1:1 with
/// either. This is the same kind of decoupling [`SampleRing`] already
/// provides for the system-audio path, but deliberately *not* a
/// [`SampleRing`]: both the push and the pop here always happen inside the
/// same [`MixState::handle_mic_block`] call, on the mic capture callback
/// thread — there is no second thread to guard against, so this holds its
/// buffer in a plain (unlocked) [`VecDeque`] instead of paying
/// [`SampleRing`]'s internal `Mutex` cost on every realtime callback.
///
/// This is what replaced the second full sinc resample
/// ([`Resampler::new`] 16kHz→native) that used to run here: the native-rate
/// mono now comes from [`Pipeline`] directly (computed once, before it was
/// ever downsampled to 16kHz), so there is nothing left to resample —
/// only frame-count bookkeeping to decouple.
struct NativeMicBuffer {
    buffered: std::collections::VecDeque<f32>,
    /// Safety net against unbounded growth if `native_mono` and
    /// `frames_needed` were ever to disagree by more than a transient
    /// amount (not expected in steady-state operation, where both track
    /// the same wall-clock audio stream) — mirrors
    /// [`SampleRing::push`]'s own overflow policy of dropping the oldest
    /// buffered samples first.
    capacity: usize,
}

impl NativeMicBuffer {
    fn new(native_rate_hz: u32) -> Self {
        let (capacity_frames, _) = ring_capacity_and_target_frames(native_rate_hz);
        Self {
            buffered: std::collections::VecDeque::with_capacity(capacity_frames),
            capacity: capacity_frames,
        }
    }

    /// Appends `native_mono`, then pops exactly `frames_needed` frames
    /// (zero-padded on underrun), mirroring [`SampleRing::pop_into`]'s
    /// contract.
    fn push_and_pop(&mut self, native_mono: &[f32], frames_needed: usize) -> Vec<f32> {
        self.buffered.extend(native_mono.iter().copied());
        if self.buffered.len() > self.capacity {
            let keep = self.capacity.min(self.buffered.len());
            let drop_count = self.buffered.len() - keep;
            self.buffered.drain(..drop_count);
        }
        let available = self.buffered.len().min(frames_needed);
        let mut out: Vec<f32> = self.buffered.drain(..available).collect();
        out.resize(frames_needed, 0.0);
        out
    }
}

/// Owns the downmix + resample pipeline and the caller's sample callback.
struct Pipeline<F: FnMut(&[f32], &[f32]) + Send + 'static> {
    source_channels: u16,
    resampler: Resampler,
    /// Native-rate mono (post-downmix, pre-resample) accumulated since the
    /// last time `on_samples` fired, handed off (then cleared) at that
    /// point — see [`Pipeline::push`]'s doc comment. This is the tap that
    /// lets [`capture_microphone_with_playback`] and
    /// [`MixState::handle_mic_block`] derive genuine native-rate `playback`
    /// audio without a second sinc resample reconstructing it from the
    /// already-16kHz-bandlimited `mic` feed.
    native_accum: Vec<f32>,
    on_samples: F,
}

impl<F: FnMut(&[f32], &[f32]) + Send + 'static> Pipeline<F> {
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
            native_accum: Vec::new(),
            on_samples,
        })
    }

    /// Downmixes and resamples `interleaved` exactly as before, additionally
    /// accumulating the native-rate mono into `native_accum`. `on_samples`
    /// fires — with the accumulated native-rate mono alongside the
    /// resampled 16kHz mono — only when `normalized` is non-empty, exactly
    /// the same gating as before this accumulation existed, so the 16kHz
    /// STT feed's cadence and content are byte-identical to before.
    fn push(&mut self, interleaved: &[f32]) {
        let mono = downmix_to_mono(interleaved, self.source_channels);
        self.native_accum.extend_from_slice(&mono);
        let normalized = self.resampler.process(&mono);
        if !normalized.is_empty() {
            (self.on_samples)(&self.native_accum, &normalized);
            self.native_accum.clear();
        }
    }

    /// Drains the resampler's tail exactly as before, additionally handing
    /// off any native-rate mono still accumulated but not yet delivered
    /// (see [`Pipeline::push`]) — so a recording's very last fraction of a
    /// second of native mic audio isn't silently dropped from `playback`.
    fn flush_tail(&mut self) {
        let tail = self.resampler.flush();
        if !tail.is_empty() {
            (self.on_samples)(&self.native_accum, &tail);
            self.native_accum.clear();
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
    F: FnMut(&[f32], &[f32]) + Send + 'static,
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
    F: FnMut(&[f32], &[f32]) + Send + 'static,
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
                           _targets: &SystemAudioAttachTargets|
         -> Result<AttachedSystemAudio, AudioError> {
            Err(AudioError::SystemAudioUnavailable(
                "fake attach failure".to_string(),
            ))
        };
        let fake_mic_only = move |_device: &DeviceInfo,
                                  _config: &CaptureConfig,
                                  _stop: Arc<AtomicBool>,
                                  _on_native_rate: BoxedRateSink,
                                  _on_samples: BoxedSampleSink|
              -> Result<(), AudioError> {
            mic_only_called_for_fake.store(true, Ordering::SeqCst);
            Ok(())
        };
        // (Older revisions of this test asserted only that `mic_only` ran;
        // see `capture_mixed_falls_back_to_microphone_only_with_non_empty_playback`
        // below for the HIGH #5 regression coverage of what it delivers.)

        // Act
        let result = capture_mixed_inner(
            MixedCaptureParams {
                device: &device,
                config: &config,
                system_source: None,
                stop,
            },
            |_block: &TrackBlock<'_>| {},
            move |_source| system_source_reported_for_cb.store(true, Ordering::SeqCst),
            |_rate: u32| {},
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

    /// HIGH #5 regression test: the automatic mic-only fallback (triggered
    /// when the system-audio attach fails, see the test above) used to
    /// deliver `playback: &[]` on every block for the whole recording —
    /// indistinguishable from the documented "still warming up" race
    /// window. Since production wires `mic_only` to
    /// `capture_microphone_with_playback_boxed`, which forwards genuine
    /// native-rate stereo, this fakes that same two-argument shape and
    /// asserts the `TrackBlock` that reaches the outer `on_samples` carries
    /// it through unmodified rather than substituting an empty slice.
    #[test]
    fn capture_mixed_falls_back_to_microphone_only_with_non_empty_playback() {
        // Arrange
        let device = DeviceInfo {
            name: "fake-device".to_string(),
        };
        let config = CaptureConfig::default();
        let stop = Arc::new(AtomicBool::new(true));

        let received: Arc<Mutex<Vec<Vec<f32>>>> = Arc::new(Mutex::new(Vec::new()));
        let received_for_sink = Arc::clone(&received);
        let reported_rate: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));
        let reported_rate_for_fake = Arc::clone(&reported_rate);

        let fake_attach = |_system_source: Option<&str>,
                           _targets: &SystemAudioAttachTargets|
         -> Result<AttachedSystemAudio, AudioError> {
            Err(AudioError::SystemAudioUnavailable(
                "fake attach failure".to_string(),
            ))
        };
        // Stands in for `capture_microphone_with_playback_boxed`: delivers
        // one block carrying genuine (non-empty) native-rate stereo, the
        // same shape `capture_microphone_with_playback` actually produces —
        // and, like the real adapter, forwards the fallback's own
        // `on_native_rate` report through unmodified (HIGH #5 sibling: the
        // fallback must report the mic's rate, not stay silent forever).
        let fake_mic_only = move |_device: &DeviceInfo,
                                  _config: &CaptureConfig,
                                  _stop: Arc<AtomicBool>,
                                  on_native_rate: BoxedRateSink,
                                  mut on_samples: BoxedSampleSink|
              -> Result<(), AudioError> {
            on_native_rate(48_000);
            let mic = vec![0.1_f32; 4];
            let playback = vec![0.2_f32; 8];
            on_samples(&mic, &playback);
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
            move |block: &TrackBlock<'_>| {
                if let Ok(mut received) = received_for_sink.lock() {
                    received.push(block.playback.to_vec());
                }
            },
            |_source| {},
            move |rate: u32| {
                *reported_rate_for_fake.lock().expect("reported rate lock") = Some(rate);
            },
            fake_attach,
            fake_mic_only,
        );

        // Assert
        assert!(result.is_ok(), "expected the fallback's Ok to propagate");
        let received = received.lock().expect("received-blocks lock");
        assert_eq!(received.len(), 1, "expected exactly one delivered block");
        assert!(
            !received[0].is_empty(),
            "mic-only fallback must not deliver an empty `playback` forever \
             (HIGH #5) — it must carry real mic-native stereo"
        );
        assert_eq!(
            received[0],
            vec![0.2_f32; 8],
            "the fallback's genuine playback content must reach on_samples unmodified"
        );
        assert_eq!(
            *reported_rate.lock().expect("reported rate lock"),
            Some(48_000),
            "the mic-only fallback's own native rate must reach on_native_rate unmodified"
        );
    }

    /// HIGH #4 regression test: a stall-recovery rebuild that negotiates a
    /// DIFFERENT native rate than the one pinned at the first attach must be
    /// rejected, not silently accepted as an identity passthrough — see
    /// `rebuild_rate_is_acceptable`'s doc comment. Constructing a real,
    /// mismatched rebuild end-to-end would require a real Core Audio tap
    /// (out of scope without hardware / `MYNA_LIVE_AUDIO_TESTS`); this
    /// exercises the pure decision `MixState::trigger_rebuild` makes on the
    /// background thread before installing (or rejecting) the rebuilt
    /// handle.
    #[test]
    fn rebuild_rate_is_acceptable_rejects_a_rate_different_from_the_pinned_one() {
        assert!(
            rebuild_rate_is_acceptable(48_000, 48_000),
            "a rebuild at the same rate it was pinned at must be accepted"
        );
        assert!(
            !rebuild_rate_is_acceptable(48_000, 44_100),
            "a rebuild at a DIFFERENT rate than pinned must be rejected, or \
             `playback`'s pitch/speed silently desyncs for the rest of the recording"
        );
    }

    /// An owned copy of one delivered [`TrackBlock`] (`(mic, system)`),
    /// named to keep the two `handle_mic_block` / `drain_ring_remainder`
    /// tests below from tripping `clippy::type_complexity`.
    type ReceivedTrackBlock = (Option<Vec<f32>>, Option<Vec<f32>>);

    /// Builds a [`MixState`] wired to a fresh, empty `ring` and `on_samples`,
    /// with `native_rate` set to `TARGET_SAMPLE_RATE` (ratio 1, so the
    /// native mic buffer is trivial) unless a test needs otherwise, and
    /// every other field at an inert default — shared by the
    /// `handle_mic_block` / `drain_ring_remainder` tests below so none of
    /// them touch a real Core Audio tap, cpal device, or resampler.
    fn test_mixer<F>(ring: Arc<SampleRing>, native_rate: u32, on_samples: F) -> MixState<F>
    where
        F: FnMut(&TrackBlock<'_>) + Send + 'static,
    {
        MixState {
            ring,
            resampler: Arc::new(Mutex::new(DeferredResampler::pending())),
            playback_ring_slot: Arc::new(Mutex::new(None)),
            playback_resampler: Arc::new(Mutex::new(DeferredResampler::pending())),
            last_activity: Arc::new(Mutex::new(Instant::now())),
            last_nonzero_activity: Arc::new(Mutex::new(Instant::now())),
            handle: Arc::new(Mutex::new(None)),
            rebuilding: Arc::new(AtomicBool::new(false)),
            system_source: None,
            drift: DriftController::new(TARGET_FILL_SAMPLES),
            last_adjustment: 0.0,
            stalled: false,
            rendering_query: RateLimitedQuery::new(RENDERING_QUERY_MIN_INTERVAL),
            native_mic_buffer: NativeMicBuffer::new(native_rate),
            native_rate,
            playback_scratch: Vec::new(),
            on_samples,
        }
    }

    /// Phase 2a regression test: `handle_mic_block` used to sum mic and
    /// system audio via `mix_into` before ever reaching `on_samples`. A mic
    /// block of all `0.5` mixed with a system block of all `0.25` would have
    /// produced `0.7 * 0.5 + 0.7 * 0.25 = 0.525` — proving the two tracks
    /// must now arrive to `on_samples` unsummed, at their original values,
    /// as equal-length slices.
    #[test]
    fn handle_mic_block_delivers_mic_and_system_tracks_unsummed() {
        // Arrange
        let ring = Arc::new(SampleRing::new(SYSTEM_RING_CAPACITY, TARGET_FILL_SAMPLES));
        ring.push(&[0.25_f32; 4]);

        let received: Arc<Mutex<Vec<ReceivedTrackBlock>>> = Arc::new(Mutex::new(Vec::new()));
        let received_for_sink = Arc::clone(&received);

        let mut mixer = test_mixer(ring, TARGET_SAMPLE_RATE, move |block: &TrackBlock<'_>| {
            if let Ok(mut received) = received_for_sink.lock() {
                received.push((
                    block.mic.map(<[f32]>::to_vec),
                    block.system.map(<[f32]>::to_vec),
                ));
            }
        });
        let mic_block = vec![0.5_f32; 4];

        // Act: native_rate is TARGET_SAMPLE_RATE here, so the native-rate
        // equivalent of `mic_block` is itself.
        mixer.handle_mic_block(&mic_block, &mic_block);

        // Assert
        let received = received.lock().expect("received-blocks lock");
        assert_eq!(received.len(), 1, "expected exactly one delivered block");
        let (mic, system) = received[0].clone();
        assert_eq!(
            mic,
            Some(vec![0.5_f32; 4]),
            "mic track must arrive unscaled"
        );
        assert_eq!(
            system,
            Some(vec![0.25_f32; 4]),
            "system track must arrive unscaled, not summed with mic"
        );
        assert_eq!(
            mic.expect("mic present").len(),
            system.expect("system present").len(),
            "mic and system slices must be equal-length"
        );
    }

    /// Phase 2a regression test: the tail flush after the mic stream stops
    /// used to mix leftover system audio against silence via `mix_into`. It
    /// must now deliver `mic: None` — there is no more mic audio to
    /// contribute at this point — with the leftover system audio intact.
    #[test]
    fn drain_ring_remainder_flushes_system_only_with_mic_none() {
        // Arrange
        let ring = Arc::new(SampleRing::new(SYSTEM_RING_CAPACITY, TARGET_FILL_SAMPLES));
        ring.push(&[0.25_f32; 4]);

        let received: Arc<Mutex<Vec<ReceivedTrackBlock>>> = Arc::new(Mutex::new(Vec::new()));
        let received_for_sink = Arc::clone(&received);

        let mut mixer = test_mixer(ring, TARGET_SAMPLE_RATE, move |block: &TrackBlock<'_>| {
            if let Ok(mut received) = received_for_sink.lock() {
                received.push((
                    block.mic.map(<[f32]>::to_vec),
                    block.system.map(<[f32]>::to_vec),
                ));
            }
        });

        // Act
        mixer.drain_ring_remainder();

        // Assert
        let received = received.lock().expect("received-blocks lock");
        assert_eq!(received.len(), 1, "expected exactly one flushed block");
        let (mic, system) = received[0].clone();
        assert_eq!(mic, None, "tail flush must not fabricate mic silence");
        assert_eq!(
            system,
            Some(vec![0.25_f32; 4]),
            "tail flush must still deliver the leftover system audio"
        );
    }

    /// Phase 2b regression test: a simulated system-audio input with
    /// DISTINCT L and R content must survive to `TrackBlock::playback` with
    /// L and R still distinct — proving the stereo image is never collapsed
    /// to mono anywhere in the tap -> resample -> ring -> callback path this
    /// test exercises (seeding `playback_ring_slot` directly, then driving
    /// `handle_mic_block`, mirroring how `attach_system_audio_to_ring`
    /// would have populated it from a real tap).
    #[test]
    fn handle_mic_block_preserves_distinct_stereo_image_in_playback() {
        // Arrange: native rate 3x the mic's 16kHz, so frame-count scaling is
        // exercised too. L is silence, R is full-scale — an accidental
        // downmix to mono would make them equal.
        let native_rate = 48_000_u32;
        let ring = Arc::new(SampleRing::new(SYSTEM_RING_CAPACITY, TARGET_FILL_SAMPLES));
        let frame_count = 12; // mic_block.len() (4) * native_rate/16000 (3)
        let playback_ring = Arc::new(SampleRing::with_frame_size(
            frame_count * 2,
            frame_count * 2,
            2,
        ));
        let mut stereo_seed = Vec::with_capacity(frame_count * 2);
        for _ in 0..frame_count {
            stereo_seed.push(0.0_f32); // L
            stereo_seed.push(0.8_f32); // R
        }
        playback_ring.push(&stereo_seed);

        let received: Arc<Mutex<Vec<Vec<f32>>>> = Arc::new(Mutex::new(Vec::new()));
        let received_for_sink = Arc::clone(&received);
        let mut mixer = test_mixer(ring, native_rate, move |block: &TrackBlock<'_>| {
            if let Ok(mut received) = received_for_sink.lock() {
                received.push(block.playback.to_vec());
            }
        });
        *mixer
            .playback_ring_slot
            .lock()
            .expect("playback ring slot lock") = Some(playback_ring);
        let mic_block = vec![0.0_f32; 4];
        // All-zero native mic mono, matching `mic_block`'s content — an
        // accidental sign or scale error here would still leave L == R
        // false only by luck, so the assertion below is meaningful.
        let native_mono = vec![0.0_f32; frame_count];

        // Act
        mixer.handle_mic_block(&native_mono, &mic_block);

        // Assert
        let received = received.lock().expect("received lock");
        assert_eq!(received.len(), 1, "expected exactly one delivered block");
        let playback = &received[0];
        assert_eq!(
            playback.len(),
            frame_count * 2,
            "playback must be a whole number of native-rate stereo frames"
        );
        for frame in 0..frame_count {
            let left = playback[frame * 2];
            let right = playback[frame * 2 + 1];
            assert_ne!(
                left, right,
                "L and R must remain distinct in playback, frame {frame}"
            );
        }
    }

    /// Phase 2b regression test: `playback`'s frame count follows the
    /// native rate (not 16kHz), while `mic`/`system` remain unchanged 16kHz
    /// mono — proving the three tracks are sized independently rather than
    /// one silently coercing another's rate.
    #[test]
    fn handle_mic_block_sizes_playback_at_native_rate_leaving_mic_and_system_at_16k() {
        // Arrange: deliberately not an integer multiple of 16kHz.
        let native_rate = 44_100_u32;
        let ring = Arc::new(SampleRing::new(SYSTEM_RING_CAPACITY, TARGET_FILL_SAMPLES));
        ring.push(&[0.1_f32; 8]);

        let received: Arc<Mutex<Vec<(usize, usize, usize)>>> = Arc::new(Mutex::new(Vec::new()));
        let received_for_sink = Arc::clone(&received);
        let mut mixer = test_mixer(ring, native_rate, move |block: &TrackBlock<'_>| {
            if let Ok(mut received) = received_for_sink.lock() {
                received.push((
                    block.mic.map(<[f32]>::len).unwrap_or(0),
                    block.system.map(<[f32]>::len).unwrap_or(0),
                    block.playback.len(),
                ));
            }
        });
        let mic_block = vec![0.2_f32; 8];
        let expected_frames = native_frames_for(mic_block.len(), native_rate);
        let native_mono = vec![0.2_f32; expected_frames];

        // Act
        mixer.handle_mic_block(&native_mono, &mic_block);

        // Assert
        let received = received.lock().expect("received lock");
        let (mic_len, system_len, playback_len) = received[0];
        assert_eq!(
            mic_len, 8,
            "mic must stay 16kHz mono, unchanged by this phase"
        );
        assert_eq!(
            system_len, 8,
            "system must stay 16kHz mono, unchanged by this phase"
        );
        assert_eq!(
            playback_len % 2,
            0,
            "playback must be a whole number of stereo frames"
        );
        assert_eq!(
            playback_len,
            expected_frames * 2,
            "playback frame count must scale with the native rate, not 16kHz"
        );
    }
}
