//! Sample-rate conversion and channel downmixing.
//!
//! Both Parakeet-TDT and Silero VAD require 16 kHz mono f32 input. Normalizing
//! here means neither `myna-stt` nor the Tauri app needs its own resampler.

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::audioadapter_buffers::owned::InterleavedOwned;
use rubato::{
    Adjustable, Async, FixedAsync, Indexing, Resampler as RubatoResampler,
    SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

use crate::error::AudioError;

/// Target sample rate every capture and playback path in Myna normalizes to.
pub const TARGET_SAMPLE_RATE: u32 = 16_000;

const SINC_LEN: usize = 128;
const OVERSAMPLING_FACTOR: usize = 256;
const CHUNK_SIZE_FRAMES: usize = 1024;
/// Rubato rejects every `set_resample_ratio_relative` call when the
/// resampler was built with a max relative ratio of exactly `1.0` (its
/// bounds check requires strictly wider headroom than the identity ratio).
/// The fixed-rate mic path never adjusts its ratio, so it keeps this tight
/// bound; [`Resampler::new_adjustable`] takes a wider one.
const MAX_RESAMPLE_RATIO_RELATIVE: f64 = 1.0;
const MONO_CHANNELS: usize = 1;
/// Channel count for [`Resampler::new_adjustable_stereo`] — the only other
/// channel count this module supports today, alongside [`MONO_CHANNELS`].
const STEREO_CHANNELS: usize = 2;

/// Converts mono f32 audio between sample rates.
///
/// Streaming-friendly: call [`Resampler::process`] repeatedly with
/// arbitrarily sized chunks, then call [`Resampler::flush`] once at the end
/// to drain any samples still buffered internally.
pub struct Resampler {
    inner: ResamplerInner,
}

enum ResamplerInner {
    /// `from_hz == to_hz`: pass samples through unchanged.
    Identity,
    Sinc(Box<SincState>),
}

struct SincState {
    resampler: Async<f32>,
    /// Fixed input chunk size, in **frames** (one frame = [`SincState::channels`]
    /// interleaved samples) — channel-count-independent, matching rubato's
    /// own `input_frames_next`/`output_frames_max` units.
    chunk_size: usize,
    /// Number of interleaved channels this instance was built for: `1` for
    /// the mono path ([`Resampler::new`] / [`Resampler::new_adjustable`]),
    /// `2` for [`Resampler::new_adjustable_stereo`]. Every sample-count
    /// (as opposed to frame-count) bookkeeping below multiplies by this.
    channels: usize,
    input_buffer: Vec<f32>,
    delay_to_trim: usize,
    /// Reused across [`SincState::process`]'s inner loop so splitting
    /// `input_buffer` into fixed-size chunks never allocates a fresh `Vec`
    /// via `drain(..).collect()` on every chunk. Emptied (via
    /// [`Vec::clear`], which retains capacity) at the top of each
    /// iteration.
    ///
    /// This resampler now runs inline on a hard-realtime audio callback
    /// thread for system-audio capture (see `crate::capture`'s module
    /// docs and `myna_coreaudio_tap::tap`'s realtime-safety notes) rather
    /// than off a softer dispatch queue, so per-chunk allocation here is
    /// audited the same way. [`SincState::process_chunk`]'s output buffer
    /// still allocates once per chunk — that one is inherent to
    /// [`Resampler::process`]'s public contract of returning an owned
    /// `Vec<f32>` the caller takes ownership of, so it can't be eliminated
    /// without breaking that API.
    chunk_scratch: Vec<f32>,
}

impl Resampler {
    /// Builds a resampler converting from `from_hz` to `to_hz`.
    ///
    /// Takes an identity fast path when the rates are already equal.
    pub fn new(from_hz: u32, to_hz: u32) -> Result<Self, AudioError> {
        if from_hz == to_hz {
            return Ok(Self {
                inner: ResamplerInner::Identity,
            });
        }

        let state = SincState::new(from_hz, to_hz)?;
        Ok(Self {
            inner: ResamplerInner::Sinc(Box::new(state)),
        })
    }

    /// Builds a resampler like [`Resampler::new`], but with `max_relative`
    /// headroom on its resample ratio so it can be adjusted afterward via
    /// [`Resampler::set_ratio_relative`] (used for system-audio drift
    /// correction).
    ///
    /// Unlike `new`, this never takes the identity fast path: an identity
    /// resampler has no internal ratio to adjust, so even when
    /// `from_hz == to_hz` this builds a real sinc resampler with the given
    /// headroom.
    pub fn new_adjustable(from_hz: u32, to_hz: u32, max_relative: f64) -> Result<Self, AudioError> {
        let state = SincState::new_with_max_relative(from_hz, to_hz, max_relative)?;
        Ok(Self {
            inner: ResamplerInner::Sinc(Box::new(state)),
        })
    }

    /// Builds an adjustable **interleaved-stereo** resampler nominally
    /// converting `rate_hz` to itself (ratio `1.0`), with `max_relative`
    /// headroom so [`Resampler::set_ratio_relative`] can still nudge it —
    /// used to keep a genuine native-rate stereo passthrough
    /// (`crate::capture`'s playback track) mutually in sync with the
    /// mono-at-16kHz system-audio track's own [`crate::mixer::DriftController`]
    /// correction, without ever resampling away from the tap's true native
    /// rate beyond that small adjustment.
    ///
    /// Like [`Resampler::new_adjustable`], this never takes the identity
    /// fast path — an identity resampler has no ratio to adjust — so it
    /// always builds a real sinc resampler, just with two interleaved
    /// channels instead of one.
    pub fn new_adjustable_stereo(rate_hz: u32, max_relative: f64) -> Result<Self, AudioError> {
        let state = SincState::new_with_max_relative_and_channels(
            rate_hz,
            rate_hz,
            max_relative,
            STEREO_CHANNELS,
        )?;
        Ok(Self {
            inner: ResamplerInner::Sinc(Box::new(state)),
        })
    }

    /// Adjusts the resample ratio by `relative` (e.g. `0.001` means "output
    /// 0.1% faster than the ratio this resampler was constructed with").
    ///
    /// A no-op returning `Ok(())` when `self` is the identity resampler
    /// (built via [`Resampler::new`] with `from_hz == to_hz`) — there is no
    /// ratio to adjust in that case.
    pub fn set_ratio_relative(&mut self, relative: f64) -> Result<(), AudioError> {
        match &mut self.inner {
            ResamplerInner::Identity => Ok(()),
            ResamplerInner::Sinc(state) => state.set_ratio_relative(relative),
        }
    }

    /// Resamples `input`, returning any output frames produced so far.
    ///
    /// Input shorter than the resampler's internal chunk size is buffered
    /// and returned by a later call or by [`Resampler::flush`].
    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        match &mut self.inner {
            ResamplerInner::Identity => input.to_vec(),
            ResamplerInner::Sinc(state) => state.process(input),
        }
    }

    /// Drains any samples still buffered internally, producing a final
    /// (possibly shorter) chunk of output. Call once, after the last
    /// [`Resampler::process`] call.
    pub fn flush(&mut self) -> Vec<f32> {
        match &mut self.inner {
            ResamplerInner::Identity => Vec::new(),
            ResamplerInner::Sinc(state) => state.flush(),
        }
    }
}

impl SincState {
    fn new(from_hz: u32, to_hz: u32) -> Result<Self, AudioError> {
        Self::new_with_max_relative(from_hz, to_hz, MAX_RESAMPLE_RATIO_RELATIVE)
    }

    fn new_with_max_relative(
        from_hz: u32,
        to_hz: u32,
        max_relative: f64,
    ) -> Result<Self, AudioError> {
        Self::new_with_max_relative_and_channels(from_hz, to_hz, max_relative, MONO_CHANNELS)
    }

    fn new_with_max_relative_and_channels(
        from_hz: u32,
        to_hz: u32,
        max_relative: f64,
        channels: usize,
    ) -> Result<Self, AudioError> {
        let params = SincInterpolationParameters::new(SINC_LEN, WindowFunction::BlackmanHarris2)
            .oversampling_factor(OVERSAMPLING_FACTOR)
            .interpolation(SincInterpolationType::Linear);
        let ratio = to_hz as f64 / from_hz as f64;

        let resampler = Async::<f32>::new_sinc(
            ratio,
            max_relative,
            &params,
            CHUNK_SIZE_FRAMES,
            channels,
            FixedAsync::Input,
        )
        .map_err(|err| AudioError::Resample(err.to_string()))?;

        let delay_to_trim = resampler.output_delay();
        let chunk_size = resampler.input_frames_next();

        Ok(Self {
            resampler,
            chunk_size,
            channels,
            input_buffer: Vec::new(),
            delay_to_trim,
            chunk_scratch: Vec::with_capacity(chunk_size * channels),
        })
    }

    /// Adjusts the resample ratio relative to the ratio this resampler was
    /// constructed with. Ramps smoothly over the next processed chunk to
    /// avoid an audible discontinuity.
    fn set_ratio_relative(&mut self, relative: f64) -> Result<(), AudioError> {
        self.resampler
            .set_resample_ratio_relative(1.0 + relative, true)
            .map_err(|err| AudioError::Resample(err.to_string()))
    }

    fn process(&mut self, input: &[f32]) -> Vec<f32> {
        self.input_buffer.extend_from_slice(input);

        let chunk_samples = self.chunk_size * self.channels;
        let mut output = Vec::new();
        while self.input_buffer.len() >= chunk_samples {
            self.chunk_scratch.clear();
            self.chunk_scratch
                .extend(self.input_buffer.drain(..chunk_samples));

            // Temporarily move `chunk_scratch` out (leaving a non-allocating
            // `Vec::new()` placeholder) so it can be passed as a plain
            // slice to `process_chunk` without a `&self` / `&mut self`
            // borrow conflict, then restore it (still holding its original
            // capacity) for the next iteration.
            let chunk = std::mem::take(&mut self.chunk_scratch);
            output.extend(self.process_chunk(&chunk, None));
            self.chunk_scratch = chunk;
        }
        output
    }

    fn flush(&mut self) -> Vec<f32> {
        if self.input_buffer.is_empty() {
            return Vec::new();
        }

        let valid_samples = self.input_buffer.len();
        let valid_frames = valid_samples / self.channels;
        let mut chunk = std::mem::take(&mut self.input_buffer);
        chunk.resize(self.chunk_size * self.channels, 0.0);
        self.process_chunk(&chunk, Some(valid_frames))
    }

    fn process_chunk(&mut self, chunk: &[f32], partial_len: Option<usize>) -> Vec<f32> {
        let input_adapter = InterleavedSlice::new(chunk, self.channels, self.chunk_size)
            .expect("chunk is sized to the resampler's fixed input length");
        let out_frames = self.resampler.output_frames_max();
        let mut output_buffer = InterleavedOwned::<f32>::new(0.0, self.channels, out_frames);
        let indexing = partial_len.map(|len| Indexing::new().partial_len(len));

        let (_consumed, produced) = self
            .resampler
            .process_into_buffer(&input_adapter, &mut output_buffer, indexing.as_ref())
            .expect("resampler input/output buffers satisfy trait invariants");

        let mut data = output_buffer.take_data();
        data.truncate(produced * self.channels);

        if self.delay_to_trim > 0 {
            let trim = self.delay_to_trim.min(data.len());
            data.drain(0..trim);
            self.delay_to_trim -= trim;
        }

        data
    }
}

/// Averages an interleaved multi-channel buffer down to a single mono channel.
///
/// Returns `interleaved` unchanged when `channels <= 1`.
pub fn downmix_to_mono(interleaved: &[f32], channels: u16) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }

    let channels = channels as usize;
    interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}
