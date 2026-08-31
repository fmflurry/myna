//! Silero VAD-based speech segmentation.

use std::path::PathBuf;

use sherpa_onnx::{SileroVadModelConfig, VadModelConfig, VoiceActivityDetector};

use crate::error::SttError;

/// Number of samples the Silero VAD model consumes per internal window at
/// [`TARGET_SAMPLE_RATE`].
pub const VAD_WINDOW_SIZE: usize = 512;

/// Sample rate every VAD/STT component in this crate operates at. Matches
/// `myna_audio::TARGET_SAMPLE_RATE`.
pub const TARGET_SAMPLE_RATE: i32 = 16_000;

/// Size, in seconds, of the VAD's internal ring buffer of speech segments.
pub const VAD_BUFFER_SECS: f32 = 60.0;

/// Number of ORT intra-op threads the Silero VAD session runs with.
///
/// Silero processes [`VAD_WINDOW_SIZE`] (512) samples per internal window —
/// far too small a unit of work to parallelize usefully. Before this
/// constant existed, `VadModelConfig { .. VadModelConfig::default() }` left
/// `num_threads` at its zero value, which ONNX Runtime does *not* treat as
/// "one thread": `0` means "use the ORT default" (one pool per session,
/// sized to the detected core count). That silently spun up a full-width
/// thread pool for a workload too small to benefit from it. This is a
/// latent-defect fix, not a tuning choice — pinning to `1` removes pool
/// overhead with no accuracy or latency tradeoff.
pub const VAD_NUM_THREADS: i32 = 1;

/// Default minimum silence duration, in seconds, before the VAD closes a
/// speech segment. Matches the upstream (k2-fsa/sherpa-onnx) recommended
/// value. Lowering this fragments natural speech: a ~0.25s pause is
/// routine *mid-sentence*, so a lower value (this project previously used
/// `0.25`) treats those pauses as utterance boundaries, chopping
/// sentences apart. Measured on this project's French fixture: at `0.25`,
/// "Ne vous demandez pas ce que votre pays peut faire pour vous..." was
/// split into four fragments, destroying a word ("pays" truncated to "P")
/// and every fragment's leading capital/trailing full stop.
pub const DEFAULT_MIN_SILENCE_SEC: f32 = 0.5;

/// Tuning for [`VadSegmenter`].
#[derive(Debug, Clone)]
pub struct VadConfig {
    pub model_path: PathBuf,
    pub threshold: f32,
    pub min_silence_sec: f32,
    pub min_speech_sec: f32,
    /// **Not a hard cap.** Despite the name, `VoiceActivityDetector::
    /// accept_waveform` never force-closes a segment once it exceeds this
    /// value — it only *tightens* the VAD's own closing behaviour
    /// (shorter `min_silence`, higher `threshold`), which can still let a
    /// segment run well past this value. That gap is exactly how a
    /// previous `max_speech_sec: 30.0` setting produced a measured 33.12s
    /// segment in production, which in turn triggered Parakeet-TDT v3's
    /// French->English language-drift bug (see
    /// `crate::stream::MAX_DECODE_CHUNK_SEC`'s doc comment for the
    /// measurements). The real hard cap is enforced in `crate::stream` by
    /// `SimulatedStreamer::drain_finals`, which splits any VAD segment
    /// longer than `MAX_DECODE_CHUNK_SEC` into consecutive decoded chunks.
    /// This field is defence-in-depth, not the enforcement mechanism: it
    /// is kept in step with `MAX_DECODE_CHUNK_SEC` so that, even if the
    /// streamer's own splitter ever regressed, the VAD's tightening
    /// behaviour would still kick in at the same ~7s threshold instead of
    /// the old 30s ceiling.
    pub max_speech_sec: f32,
}

// Hand-written rather than `#[derive(Default)]`: `VadModelConfig::default()`
// zeroes every numeric field, which is not a usable VAD configuration. These
// are the upstream-recommended tuning values.
impl Default for VadConfig {
    fn default() -> Self {
        Self {
            model_path: PathBuf::new(),
            threshold: 0.5,
            min_silence_sec: DEFAULT_MIN_SILENCE_SEC,
            min_speech_sec: 0.25,
            max_speech_sec: 7.0,
        }
    }
}

/// Wraps a Silero VAD, emitting sample-accurate speech segments.
pub struct VadSegmenter {
    vad: VoiceActivityDetector,
}

impl VadSegmenter {
    /// Loads the Silero VAD model from `cfg.model_path`.
    pub fn load(cfg: &VadConfig) -> Result<Self, SttError> {
        if !cfg.model_path.is_file() {
            return Err(SttError::ModelNotFound(cfg.model_path.clone()));
        }

        let silero_vad = SileroVadModelConfig {
            model: Some(cfg.model_path.to_string_lossy().into_owned()),
            threshold: cfg.threshold,
            min_silence_duration: cfg.min_silence_sec,
            min_speech_duration: cfg.min_speech_sec,
            window_size: VAD_WINDOW_SIZE as i32,
            max_speech_duration: cfg.max_speech_sec,
        };
        let config = VadModelConfig {
            silero_vad,
            sample_rate: TARGET_SAMPLE_RATE,
            num_threads: VAD_NUM_THREADS,
            ..VadModelConfig::default()
        };

        let vad =
            VoiceActivityDetector::create(&config, VAD_BUFFER_SECS).ok_or(SttError::VadInit)?;
        Ok(Self { vad })
    }

    /// Feeds samples to the detector.
    pub fn feed(&mut self, samples: &[f32]) {
        self.vad.accept_waveform(samples);
    }

    /// Returns `true` while speech is actively being detected.
    pub fn detected(&self) -> bool {
        self.vad.detected()
    }

    /// Pushes any buffered trailing speech into the output queue. Call this
    /// once the input stream has ended, before a final [`Self::drain_segments`].
    pub fn flush(&mut self) {
        self.vad.flush();
    }

    /// Drains every finished speech segment, pairing each one's sample
    /// offset (relative to all input seen so far) with its samples.
    pub fn drain_segments(&mut self) -> Vec<(usize, Vec<f32>)> {
        let mut segments = Vec::new();
        while let Some(segment) = self.vad.front() {
            let offset = segment.start() as usize;
            let samples = segment.samples().to_vec();
            segments.push((offset, samples));
            self.vad.pop();
        }
        segments
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_uses_the_upstream_min_silence_duration() {
        let cfg = VadConfig::default();

        assert_eq!(cfg.min_silence_sec, DEFAULT_MIN_SILENCE_SEC);
        assert_eq!(DEFAULT_MIN_SILENCE_SEC, 0.5);
    }

    #[test]
    fn default_max_speech_sec_matches_the_streamer_hard_cap_as_defence_in_depth() {
        // `max_speech_sec` used to be documented as the mechanism that
        // "force-closes" an over-long segment — it is not:
        // `VoiceActivityDetector::accept_waveform` only *tightens* the VAD
        // (shorter min_silence, higher threshold) once the buffer exceeds
        // it, and never force-closes. That gap is exactly how a
        // `max_speech_sec: 30.0` setting produced a measured 33.12s speech
        // segment in production, which in turn triggered Parakeet-TDT's
        // French->English language-drift bug (decodes beyond ~7-8s fall
        // into an English attractor and never recover for the rest of the
        // segment).
        //
        // The real hard cap now lives in `crate::stream` as
        // `MAX_DECODE_CHUNK_SEC` (`SimulatedStreamer::drain_finals` splits
        // any VAD segment longer than that into consecutive decoded
        // chunks). This default is lowered from `30.0` to match that same
        // value so the two layers agree on one "at most ~7s of speech"
        // policy: if the streamer's own splitter ever has a bug, the VAD's
        // own (non-authoritative) tightening kicks in at the same
        // threshold instead of letting a segment run all the way to the
        // old 30s ceiling. `max_speech_sec` is defence-in-depth now, not
        // the enforcement mechanism.
        let cfg = VadConfig::default();

        assert_eq!(
            cfg.max_speech_sec, 7.0,
            "max_speech_sec must be lowered to match the streamer's own hard decode-chunk \
             cap now that it is defence-in-depth rather than the primary enforcement \
             mechanism for the language-drift fix"
        );
    }
}
