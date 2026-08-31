//! Offline speaker diarization: pyannote-3.0 segmentation + NeMo TitaNet
//! embedding + fast clustering, wrapped in this crate's own model-path and
//! error conventions.
//!
//! This module does no attribution decisions itself — it only reports
//! `(start_sec, end_sec, speaker_index)` segments and a speaker count. See
//! [`crate::relabel::relabel_others`] for the pure, confidence-gated logic
//! that turns this output into `Speaker` labels on a [`crate::Transcript`].

use std::path::{Path, PathBuf};

use sherpa_onnx::{
    FastClusteringConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig,
    OfflineSpeakerSegmentationModelConfig, OfflineSpeakerSegmentationPyannoteModelConfig,
    SpeakerEmbeddingExtractorConfig,
};

use crate::error::SttError;
use crate::wav::read_wav_to_f32;

/// `min_duration_on` passed to `OfflineSpeakerDiarizationConfig`: segments
/// shorter than this are dropped by the segmentation stage.
const MIN_DURATION_ON: f32 = 0.3;

/// `min_duration_off` passed to `OfflineSpeakerDiarizationConfig`: silence
/// gaps shorter than this do not split a segment.
const MIN_DURATION_OFF: f32 = 0.5;

/// Configuration for loading a [`Diarizer`].
#[derive(Debug, Clone)]
pub struct DiarizeConfig {
    pub segmentation_model: PathBuf,
    pub embedding_model: PathBuf,
    pub num_threads: i32,
    pub threshold: f32,
}

impl Default for DiarizeConfig {
    fn default() -> Self {
        Self {
            segmentation_model: PathBuf::new(),
            embedding_model: PathBuf::new(),
            num_threads: 2,
            threshold: 0.5,
        }
    }
}

/// One diarization segment: `[start_sec, end_sec)` attributed to
/// `speaker_index` — a 0-based index assigned by clustering, stable only
/// within a single [`Diarizer::diarize_wav`] call, not a durable identity.
#[derive(Debug, Clone, PartialEq)]
pub struct DiarizeSegment {
    pub start_sec: f32,
    pub end_sec: f32,
    pub speaker_index: u32,
}

/// The full diarization output for one recording.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DiarizeResult {
    pub num_speakers: u32,
    /// Sorted by [`DiarizeSegment::start_sec`].
    pub segments: Vec<DiarizeSegment>,
}

/// Offline speaker diarizer: pyannote-3.0 segmentation + NeMo TitaNet
/// embedding + fast clustering (`num_clusters: -1` infers the speaker count
/// from `threshold` rather than requiring it up front).
pub struct Diarizer {
    inner: OfflineSpeakerDiarization,
}

impl Diarizer {
    /// Loads the segmentation and embedding model artifacts named in `cfg`.
    pub fn load(cfg: &DiarizeConfig) -> Result<Self, SttError> {
        require_artifact(&cfg.segmentation_model)?;
        require_artifact(&cfg.embedding_model)?;

        let config = OfflineSpeakerDiarizationConfig {
            segmentation: OfflineSpeakerSegmentationModelConfig {
                pyannote: OfflineSpeakerSegmentationPyannoteModelConfig {
                    model: Some(path_to_string(&cfg.segmentation_model)),
                    ..Default::default()
                },
                num_threads: cfg.num_threads,
                ..Default::default()
            },
            embedding: SpeakerEmbeddingExtractorConfig {
                model: Some(path_to_string(&cfg.embedding_model)),
                num_threads: cfg.num_threads,
                ..Default::default()
            },
            clustering: FastClusteringConfig {
                num_clusters: -1,
                threshold: cfg.threshold,
            },
            min_duration_on: MIN_DURATION_ON,
            min_duration_off: MIN_DURATION_OFF,
        };

        let inner = OfflineSpeakerDiarization::create(&config).ok_or(SttError::DiarizeInit)?;
        Ok(Self { inner })
    }

    /// Diarizes a WAV file on disk, returning segments sorted by start time.
    pub fn diarize_wav(&self, path: &Path) -> Result<DiarizeResult, SttError> {
        let (samples, _sample_rate) = read_wav_to_f32(path)?;

        let result = self
            .inner
            .process(&samples)
            .ok_or_else(|| SttError::Decode("diarization returned no result".into()))?;

        let num_speakers = result.num_speakers().max(0) as u32;
        let segments = result
            .sort_by_start_time()
            .into_iter()
            .map(|seg| DiarizeSegment {
                start_sec: seg.start,
                end_sec: seg.end,
                speaker_index: seg.speaker.max(0) as u32,
            })
            .collect();

        Ok(DiarizeResult {
            num_speakers,
            segments,
        })
    }
}

/// Joins nothing (unlike `engine::require_artifact`, model paths here are
/// already full paths, not `model_dir`-relative) — just validates `path` is
/// a file, failing with [`SttError::ModelNotFound`] otherwise.
fn require_artifact(path: &Path) -> Result<(), SttError> {
    if path.is_file() {
        Ok(())
    } else {
        Err(SttError::ModelNotFound(path.to_path_buf()))
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
    }

    fn segmentation_model() -> PathBuf {
        repo_root()
            .join("models")
            .join("pyannote-segmentation-3-0")
            .join("sherpa-onnx-pyannote-segmentation-3-0")
            .join("model.int8.onnx")
    }

    fn embedding_model() -> PathBuf {
        repo_root()
            .join("models")
            .join("nemo-titanet")
            .join("nemo_en_titanet_small.onnx")
    }

    /// Reuses the same system-audio fixture the offline decode tests use —
    /// it's already 16 kHz mono, matching what pyannote-3.0 expects, with no
    /// resampling required.
    fn speech_fixture() -> PathBuf {
        repo_root().join("recordings").join("track-system.wav")
    }

    fn models_present() -> bool {
        segmentation_model().is_file() && embedding_model().is_file() && speech_fixture().is_file()
    }

    #[test]
    fn load_rejects_a_missing_segmentation_model_before_touching_the_embedding_model() {
        // No real model artifacts are required: the artifact-presence check
        // must run, and fail, before any FFI work.
        let cfg = DiarizeConfig {
            segmentation_model: PathBuf::from("/nonexistent/segmentation.onnx"),
            embedding_model: PathBuf::from("/nonexistent/embedding.onnx"),
            ..DiarizeConfig::default()
        };

        let error = Diarizer::load(&cfg).err().expect("must be rejected");

        match error {
            SttError::ModelNotFound(path) => {
                assert_eq!(path, PathBuf::from("/nonexistent/segmentation.onnx"));
            }
            other => panic!("expected ModelNotFound, got {other:?}"),
        }
    }

    #[test]
    #[ignore]
    fn diarize_wav_reports_a_speaker_count_and_sorted_segments_on_a_real_recording() {
        // Arrange
        if !models_present() {
            eprintln!(
                "skipping: diarization models or fixture not present \
                 (see scripts/download-models.sh)"
            );
            return;
        }
        let diarizer = Diarizer::load(&DiarizeConfig {
            segmentation_model: segmentation_model(),
            embedding_model: embedding_model(),
            ..DiarizeConfig::default()
        })
        .expect("diarizer loads");

        // Act
        let result = diarizer
            .diarize_wav(&speech_fixture())
            .expect("diarize_wav succeeds");

        // Assert
        assert!(result.num_speakers >= 1, "must detect at least one speaker");
        let mut previous_start = f32::MIN;
        for segment in &result.segments {
            assert!(
                segment.start_sec >= previous_start,
                "segments must be sorted by start time"
            );
            assert!(segment.end_sec >= segment.start_sec);
            previous_start = segment.start_sec;
        }
    }
}
