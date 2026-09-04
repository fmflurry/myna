//! Rotation of classic PCM WAV recordings before their 32-bit size limit.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::{AudioError, RecordingSpec, WavRecorder};

/// Maximum PCM data bytes in one production classic-WAV part (3.5 GiB).
pub const MAX_PCM_DATA_BYTES: u64 = 3_758_096_384;
const PCM_BYTES_PER_SAMPLE: u64 = 2;

/// Aggregate statistics for every part of a segmented WAV recording.
#[derive(Debug, Clone)]
pub struct SegmentedRecordingStats {
    /// Total frames across all parts.
    pub frames: u64,
    /// Total recording duration across all parts.
    pub duration: Duration,
    /// Path to the first (base-name) part.
    pub path: PathBuf,
    /// Total PCM data bytes across all parts.
    pub bytes: u64,
    /// Number of finalized WAV parts.
    pub parts: u64,
    /// Finalized part paths in chronological order.
    pub paths: Vec<PathBuf>,
}

/// Streams audio into independently valid, classic-WAV parts.
pub struct SegmentedWavRecorder {
    current: Option<WavRecorder>,
    base_path: PathBuf,
    spec: RecordingSpec,
    part_data_limit: u64,
    current_data_bytes: u64,
    total_frames: u64,
    total_bytes: u64,
    paths: Vec<PathBuf>,
}

impl SegmentedWavRecorder {
    /// Creates a recorder with a data ceiling per part. The ceiling is capped
    /// at [`MAX_PCM_DATA_BYTES`] and is injectable to make rotation testable.
    pub fn create(path: &Path, spec: RecordingSpec, data_ceiling: u64) -> Result<Self, AudioError> {
        let bytes_per_frame = Self::bytes_per_frame(spec)?;
        if data_ceiling > MAX_PCM_DATA_BYTES || data_ceiling < bytes_per_frame {
            return Err(AudioError::Wav(format!(
                "WAV data ceiling must be between {bytes_per_frame} and {MAX_PCM_DATA_BYTES} bytes"
            )));
        }

        let current = WavRecorder::create(path, spec)?;
        Ok(Self {
            current: Some(current),
            base_path: path.to_path_buf(),
            spec,
            part_data_limit: data_ceiling / bytes_per_frame * bytes_per_frame,
            current_data_bytes: 0,
            total_frames: 0,
            total_bytes: 0,
            paths: vec![path.to_path_buf()],
        })
    }

    /// Writes interleaved normalized samples, rotating only between PCM frames.
    pub fn write(&mut self, samples: &[f32]) -> Result<(), AudioError> {
        let bytes_per_frame = Self::bytes_per_frame(self.spec)?;
        let channels = self.spec.channels as usize;
        if !samples.len().is_multiple_of(channels) {
            return Err(AudioError::Wav(
                "segmented WAV writes must contain complete PCM frames".to_string(),
            ));
        }

        let frames_per_part = (self.part_data_limit / bytes_per_frame) as usize;
        for frames in samples.chunks(channels * frames_per_part) {
            if self.current_data_bytes == self.part_data_limit {
                self.rotate()?;
            }
            let current = self.current.as_mut().ok_or_else(|| {
                AudioError::Wav("segmented WAV recorder cannot create the next part".to_string())
            })?;
            current.write_round_trip(frames)?;
            self.current_data_bytes += frames.len() as u64 * PCM_BYTES_PER_SAMPLE;
            self.total_frames += (frames.len() / channels) as u64;
            self.total_bytes += frames.len() as u64 * PCM_BYTES_PER_SAMPLE;
        }
        Ok(())
    }

    /// Finalizes the active part and returns aggregate chronological metadata.
    pub fn finalize(mut self) -> Result<SegmentedRecordingStats, AudioError> {
        self.finalize_current()?;
        let duration =
            Duration::from_secs_f64(self.total_frames as f64 / f64::from(self.spec.sample_rate));
        Ok(SegmentedRecordingStats {
            frames: self.total_frames,
            duration,
            path: self.base_path,
            bytes: self.total_bytes,
            parts: self.paths.len() as u64,
            paths: self.paths,
        })
    }

    fn rotate(&mut self) -> Result<(), AudioError> {
        self.finalize_current()?;
        let next_path = self.part_path(self.paths.len() + 1)?;
        self.current = Some(WavRecorder::create(&next_path, self.spec)?);
        self.paths.push(next_path);
        self.current_data_bytes = 0;
        Ok(())
    }

    fn finalize_current(&mut self) -> Result<(), AudioError> {
        if let Some(recorder) = self.current.take() {
            recorder.finalize()?;
        }
        Ok(())
    }

    fn bytes_per_frame(spec: RecordingSpec) -> Result<u64, AudioError> {
        let channels = u64::from(spec.channels);
        if channels == 0 || spec.sample_rate == 0 {
            return Err(AudioError::Wav(
                "segmented WAV recordings require non-zero channels and sample rate".to_string(),
            ));
        }
        Ok(channels * PCM_BYTES_PER_SAMPLE)
    }

    fn part_path(&self, part_number: usize) -> Result<PathBuf, AudioError> {
        let stem = self
            .base_path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .ok_or_else(|| {
                AudioError::Wav("segmented WAV base path must have a UTF-8 file stem".to_string())
            })?;
        let parent = self.base_path.parent().unwrap_or_else(|| Path::new(""));
        Ok(parent.join(format!("{stem}.part-{part_number:04}.wav")))
    }
}
