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
use crate::wav::WavBlockReader;

/// `min_duration_on` passed to `OfflineSpeakerDiarizationConfig`: segments
/// shorter than this are dropped by the segmentation stage.
const MIN_DURATION_ON: f32 = 0.3;

/// `min_duration_off` passed to `OfflineSpeakerDiarizationConfig`: silence
/// gaps shorter than this do not split a segment.
const MIN_DURATION_OFF: f32 = 0.5;

/// Frames pulled per [`WavBlockReader::next_block`] while assembling the
/// diarization buffer. 16,000 frames is 1 s at 16 kHz — large enough that
/// per-block overhead stays negligible, small enough that the transient
/// block is noise next to the final buffer.
const DIARIZE_BLOCK_FRAMES: usize = 16_000;

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
        // Build one owned mono buffer block-wise so the interleaved
        // all-samples Vec is never materialized: peak Rust-side memory is
        // ~1x the file's frame count (plus one transient block), not 2x.
        // Mono blocks pass through `downmix_to_mono` by move, so the common
        // 16 kHz track-system case never copies at all. The sherpa-onnx C++
        // layer keeps its own internal copy of the slice handed to
        // `process` — unavoidable through the C API — so total peak stays
        // at 2x file bytes.
        let mut reader = WavBlockReader::open(path)?;
        // The header's declared frame count is attacker-controlled for
        // user-imported files — clamp the reservation to the file's real
        // size before pre-allocating (see [`reservation_frames`]).
        let file_bytes = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        let capacity =
            reservation_frames(reader.total_frames(), file_bytes, reader.bytes_per_frame());
        let mut samples = Vec::with_capacity(capacity);
        while let Some(block) = reader.next_block(DIARIZE_BLOCK_FRAMES)? {
            samples.extend(block);
        }

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

/// Upper-bound [`Diarizer::diarize_wav`]'s sample-buffer reservation by
/// what the file can actually hold.
///
/// `declared_frames` comes from the WAV header's data-chunk length, which
/// hound reports verbatim — a corrupt or hostile user-imported file can
/// claim 2^31 frames (~8 GB of `f32`) inside a 244-byte file, and
/// `Vec::with_capacity` would take that claim at face value and abort the
/// process on the speculative allocation. The file's real byte size is the
/// only trustworthy bound: `declared.min(file_bytes / bytes_per_frame)`,
/// floored at one [`DIARIZE_BLOCK_FRAMES`] block so amortised `extend`
/// covers any residual growth. Pure so the forged-header guard is
/// unit-testable without the diarization models.
fn reservation_frames(declared_frames: u64, file_bytes: u64, bytes_per_frame: u64) -> usize {
    if bytes_per_frame == 0 {
        return DIARIZE_BLOCK_FRAMES;
    }
    let clamped = declared_frames.min(file_bytes / bytes_per_frame);
    usize::try_from(clamped)
        .unwrap_or(DIARIZE_BLOCK_FRAMES)
        .max(DIARIZE_BLOCK_FRAMES)
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
    fn reservation_frames_clamps_a_forged_wav_header_to_the_files_real_size() {
        // Arrange: a 16 kHz mono PCM16 file with 100 real frames whose
        // declared data-chunk length is forged to ~4 GB (2^31 frames). The
        // pre-fix `Vec::with_capacity(reader.total_frames())` took that
        // claim at face value — a speculative ~8 GB `f32` reservation and
        // an OOM abort on a 244-byte file.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("forged.wav");
        let mut writer = hound::WavWriter::create(
            &path,
            hound::WavSpec {
                channels: 1,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .expect("create wav");
        for frame in 0..100i16 {
            writer.write_sample(frame).expect("write sample");
        }
        writer.finalize().expect("finalize wav");
        let mut bytes = std::fs::read(&path).expect("read wav");
        assert_eq!(
            &bytes[36..40],
            b"data",
            "canonical PCM header puts the data chunk at offset 36"
        );
        let forged_len: u32 = 0xFFFF_FFFE; // even, so hound accepts the claim
        bytes[4..8].copy_from_slice(&forged_len.to_le_bytes());
        bytes[40..44].copy_from_slice(&forged_len.to_le_bytes());
        std::fs::write(&path, bytes).expect("write forged wav");

        // The header claim really is trusted by the reader layer:
        let reader = WavBlockReader::open(&path).expect("open forged wav");
        let declared = reader.total_frames();
        assert!(
            declared > 1_000_000_000,
            "forged header must claim > 10^9 frames, got {declared}"
        );

        // Act
        let file_bytes = std::fs::metadata(&path).expect("metadata").len();
        let reservation = reservation_frames(declared, file_bytes, reader.bytes_per_frame());

        // Assert: bounded by the file's real bytes, not the forged claim.
        assert!(
            reservation <= DIARIZE_BLOCK_FRAMES + (file_bytes / 2) as usize,
            "reservation {reservation} must be bounded by the file's real size \
             ({file_bytes} bytes), not the forged {declared}-frame claim"
        );
        assert!(
            reservation < 1_000_000,
            "must never speculatively reserve GB-scale memory, got {reservation} frames"
        );
    }

    #[test]
    fn reservation_frames_keeps_an_honest_header_and_survives_a_zero_sized_frame() {
        // Honest 1-hour 16 kHz mono PCM16 file: reservation equals the
        // declared count (no clamp needed, no extra copying behaviour).
        let honest_frames = 16_000u64 * 3_600;
        let file_bytes = honest_frames * 2 + 44;
        assert_eq!(
            reservation_frames(honest_frames, file_bytes, 2),
            honest_frames as usize
        );
        // Degenerate spec (bytes_per_frame == 0): fall back to the block
        // floor instead of dividing by zero.
        assert_eq!(reservation_frames(123, 456, 0), DIARIZE_BLOCK_FRAMES);
        // Tiny honest file: floored at one block, never zero.
        assert_eq!(reservation_frames(10, 64, 2), DIARIZE_BLOCK_FRAMES);
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
