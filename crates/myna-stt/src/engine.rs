//! Offline Parakeet-TDT decoding.

use std::path::{Path, PathBuf};

use sherpa_onnx::{
    OfflineRecognizer, OfflineRecognizerConfig, OfflineRecognizerResult,
    OfflineTransducerModelConfig,
};

use crate::detokenize::{detokenize, Word};
use crate::error::SttError;
use crate::transcript::{Speaker, Transcript, TranscriptSegment};
use crate::wav::read_wav_to_f32;

const ENCODER_FILE: &str = "encoder.int8.onnx";
const DECODER_FILE: &str = "decoder.int8.onnx";
const JOINER_FILE: &str = "joiner.int8.onnx";
const TOKENS_FILE: &str = "tokens.txt";
const MODEL_TYPE: &str = "nemo_transducer";

/// Default `blank_penalty` passed to `sherpa_onnx::OfflineRecognizerConfig`.
///
/// Positive values reduce deletions (dropped words) at the cost of some
/// insertions; negative values are silently ignored by sherpa-onnx.
/// sherpa-onnx issue #2605 reports dropped words on this exact model, and
/// the penalty is confirmed live on the greedy TDT decode path
/// (`offline-transducer-greedy-search-nemo-decoder.cc:141-143`). Measured
/// on this project's four fixtures (see `SttEngine` doc): `1.0` did not
/// regress any fixture, so it is the default.
pub const DEFAULT_BLANK_PENALTY: f32 = 1.0;

/// `decoding_method` value selecting sherpa-onnx's greedy search (the
/// default decode path for the transducer model this crate uses).
pub const GREEDY_SEARCH: &str = "greedy_search";

/// `decoding_method` value selecting sherpa-onnx's beam search. Supported
/// for Parakeet-TDT as of sherpa-onnx v1.13.0 (k2-fsa/sherpa-onnx#3077).
pub const MODIFIED_BEAM_SEARCH: &str = "modified_beam_search";

/// Every `decoding_method` value this crate will pass to sherpa-onnx.
///
/// sherpa-onnx does not validate `decoding_method` itself: an unrecognized
/// value reaches `OfflineRecognizer::create` and triggers a hard
/// `exit(-1)` in the underlying C++ library, not a Rust error. Any
/// caller-supplied value MUST be checked against this allowlist before
/// being placed in [`SttConfig::decoding_method`] and passed to
/// [`SttEngine::load`].
pub const ALLOWED_DECODING_METHODS: [&str; 2] = [GREEDY_SEARCH, MODIFIED_BEAM_SEARCH];

/// Configuration for loading an [`SttEngine`].
#[derive(Debug, Clone)]
pub struct SttConfig {
    pub model_dir: PathBuf,
    pub num_threads: i32,
    pub debug: bool,
    /// See [`DEFAULT_BLANK_PENALTY`].
    pub blank_penalty: f32,
    /// `None` uses sherpa-onnx's own default (greedy search). `Some(_)`
    /// must be one of [`ALLOWED_DECODING_METHODS`] — [`SttEngine::load`]
    /// rejects anything else with [`SttError::InvalidDecodingMethod`]
    /// rather than risk the process-killing sherpa-onnx behavior described
    /// on [`ALLOWED_DECODING_METHODS`].
    pub decoding_method: Option<String>,
}

impl Default for SttConfig {
    fn default() -> Self {
        Self {
            model_dir: PathBuf::new(),
            num_threads: 2,
            debug: false,
            blank_penalty: DEFAULT_BLANK_PENALTY,
            decoding_method: None,
        }
    }
}

/// Offline Parakeet-TDT speech-to-text engine.
pub struct SttEngine {
    recognizer: OfflineRecognizer,
}

impl SttEngine {
    /// Loads the Parakeet-TDT model artifacts from `cfg.model_dir`.
    pub fn load(cfg: &SttConfig) -> Result<Self, SttError> {
        // Validated before any FFI or filesystem work: an unrecognized
        // `decoding_method` reaching `OfflineRecognizer::create` below
        // triggers a process-killing `exit(-1)` inside sherpa-onnx rather
        // than a recoverable error. See `ALLOWED_DECODING_METHODS`.
        if let Some(method) = &cfg.decoding_method {
            if !ALLOWED_DECODING_METHODS.contains(&method.as_str()) {
                return Err(SttError::InvalidDecodingMethod(method.clone()));
            }
        }

        let encoder = require_artifact(&cfg.model_dir, ENCODER_FILE)?;
        let decoder = require_artifact(&cfg.model_dir, DECODER_FILE)?;
        let joiner = require_artifact(&cfg.model_dir, JOINER_FILE)?;
        let tokens = require_artifact(&cfg.model_dir, TOKENS_FILE)?;

        let mut config = OfflineRecognizerConfig::default();
        config.model_config.transducer = OfflineTransducerModelConfig {
            encoder: Some(path_to_string(&encoder)),
            decoder: Some(path_to_string(&decoder)),
            joiner: Some(path_to_string(&joiner)),
        };
        config.model_config.tokens = Some(path_to_string(&tokens));
        config.model_config.model_type = Some(MODEL_TYPE.into());
        config.model_config.num_threads = cfg.num_threads;
        config.model_config.debug = cfg.debug;
        config.blank_penalty = cfg.blank_penalty;
        config.decoding_method = cfg.decoding_method.clone();

        let recognizer = OfflineRecognizer::create(&config).ok_or(SttError::RecognizerInit)?;
        Ok(Self { recognizer })
    }

    /// Transcribes raw `samples` at `sample_rate`, returning plain text.
    pub fn transcribe_samples(
        &self,
        sample_rate: i32,
        samples: &[f32],
    ) -> Result<String, SttError> {
        let stream = self.recognizer.create_stream();
        stream.accept_waveform(sample_rate, samples);
        self.recognizer.decode(&stream);

        let result = stream
            .get_result()
            .ok_or_else(|| SttError::Decode("recognizer returned no result".into()))?;
        Ok(result.text)
    }

    /// Transcribes raw `samples` at `sample_rate`, returning detokenized
    /// words with `start_sec`/`end_sec` timing relative to the start of
    /// `samples` (i.e. the caller is responsible for offsetting them if
    /// `samples` is a slice out of a larger buffer).
    ///
    /// Shares [`detokenize`] with [`Self::transcribe_wav`] via
    /// [`words_from_result`] rather than duplicating piece-assembly logic —
    /// this is the entry point [`crate::stream::SimulatedStreamer`] uses to
    /// get word-level timing for its bounded live-partial decode window.
    pub fn transcribe_samples_words(
        &self,
        sample_rate: i32,
        samples: &[f32],
    ) -> Result<Vec<Word>, SttError> {
        let stream = self.recognizer.create_stream();
        stream.accept_waveform(sample_rate, samples);
        self.recognizer.decode(&stream);

        let result = stream
            .get_result()
            .ok_or_else(|| SttError::Decode("recognizer returned no result".into()))?;
        let duration_sec = samples.len() as f32 / sample_rate as f32;
        Ok(words_from_result(&result, duration_sec))
    }

    /// Transcribes a WAV file on disk into a timestamped [`Transcript`].
    pub fn transcribe_wav(&self, path: &Path) -> Result<Transcript, SttError> {
        let (samples, sample_rate) = read_wav_to_f32(path)?;

        let stream = self.recognizer.create_stream();
        stream.accept_waveform(sample_rate as i32, &samples);
        self.recognizer.decode(&stream);

        let result = stream
            .get_result()
            .ok_or_else(|| SttError::Decode("recognizer returned no result".into()))?;

        let duration_sec = samples.len() as f32 / sample_rate as f32;
        Ok(Transcript {
            segments: segments_from_result(&result, duration_sec),
        })
    }
}

/// Joins `model_dir` with `file_name`, failing with [`SttError::ModelNotFound`]
/// when the resulting path is not a file.
fn require_artifact(model_dir: &Path, file_name: &str) -> Result<PathBuf, SttError> {
    let path = model_dir.join(file_name);
    if path.is_file() {
        Ok(path)
    } else {
        Err(SttError::ModelNotFound(path))
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Builds transcript segments from a recognizer result by mapping
/// [`words_from_result`]'s words 1:1 onto [`TranscriptSegment`]s.
fn segments_from_result(
    result: &OfflineRecognizerResult,
    duration_sec: f32,
) -> Vec<TranscriptSegment> {
    words_from_result(result, duration_sec)
        .into_iter()
        .map(|word| TranscriptSegment {
            start_sec: word.start_sec,
            end_sec: word.end_sec,
            text: word.text,
            speaker: Speaker::default(),
            speaker_pinned: false,
        })
        .collect()
}

/// Builds detokenized words from a recognizer result, preferring per-word
/// timing derived from real per-token timestamps/durations when the model
/// reports them, and falling back to a single whole-slice word (using
/// sherpa's own already-assembled [`OfflineRecognizerResult::text`])
/// spanning `0..duration_sec` otherwise.
///
/// `result.tokens` are subword pieces, not words — see [`detokenize`] for
/// why they cannot simply be space-joined. Shared by both
/// [`SttEngine::transcribe_wav`] (via [`segments_from_result`]) and
/// [`SttEngine::transcribe_samples_words`] so detokenization logic lives in
/// exactly one place.
fn words_from_result(result: &OfflineRecognizerResult, duration_sec: f32) -> Vec<Word> {
    match (&result.timestamps, &result.durations) {
        (Some(timestamps), Some(durations)) if !timestamps.is_empty() => {
            detokenize(&result.tokens, timestamps, durations)
        }
        _ => vec![Word {
            text: result.text.clone(),
            start_sec: 0.0,
            end_sec: duration_sec,
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_rejects_an_unknown_decoding_method_before_touching_model_files() {
        // No real model artifacts are required: the allowlist check in
        // `SttEngine::load` must run, and fail, before any filesystem or
        // FFI work — guarding against sherpa-onnx's `exit(-1)` on an
        // unrecognized `decoding_method`.
        let cfg = SttConfig {
            model_dir: PathBuf::from("/nonexistent/model/dir"),
            decoding_method: Some("not_a_real_decoding_method".to_string()),
            ..SttConfig::default()
        };

        let error = SttEngine::load(&cfg).err().expect("must be rejected");

        match error {
            SttError::InvalidDecodingMethod(method) => {
                assert_eq!(method, "not_a_real_decoding_method");
            }
            other => panic!("expected InvalidDecodingMethod, got {other:?}"),
        }
    }

    #[test]
    fn load_accepts_every_allowed_decoding_method_past_the_allowlist_check() {
        for method in ALLOWED_DECODING_METHODS {
            let cfg = SttConfig {
                model_dir: PathBuf::from("/nonexistent/model/dir"),
                decoding_method: Some(method.to_string()),
                ..SttConfig::default()
            };

            // An allowed method must fail on the (nonexistent) model
            // artifacts, not on the decoding-method check.
            let error = SttEngine::load(&cfg)
                .err()
                .unwrap_or_else(|| panic!("expected ModelNotFound for {method:?}"));
            match error {
                SttError::ModelNotFound(_) => {}
                other => panic!("expected ModelNotFound for {method:?}, got {other:?}"),
            }
        }
    }
}
