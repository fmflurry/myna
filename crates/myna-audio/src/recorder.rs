//! WAV recording of normalized f32 audio to 16-bit PCM files.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::AudioError;

/// Bit depth `WavRecorder` writes to disk.
const BITS_PER_SAMPLE: u16 = 16;

/// Sample format and rate a recording is written with.
#[derive(Debug, Clone, Copy)]
pub struct RecordingSpec {
    pub sample_rate: u32,
    pub channels: u16,
}

/// Statistics returned once a recording is finalized.
#[derive(Debug, Clone)]
pub struct RecordingStats {
    pub frames: u64,
    pub duration: Duration,
    pub path: PathBuf,
}

/// Streams normalized f32 samples to a 16-bit PCM WAV file.
pub struct WavRecorder {
    writer: hound::WavWriter<std::io::BufWriter<std::fs::File>>,
    spec: RecordingSpec,
    samples_written: u64,
    path: PathBuf,
}

impl WavRecorder {
    /// Creates a new WAV file at `path`, writing 16-bit PCM audio matching
    /// `spec`.
    pub fn create(path: &Path, spec: RecordingSpec) -> Result<Self, AudioError> {
        let wav_spec = hound::WavSpec {
            channels: spec.channels,
            sample_rate: spec.sample_rate,
            bits_per_sample: BITS_PER_SAMPLE,
            sample_format: hound::SampleFormat::Int,
        };

        let writer = hound::WavWriter::create(path, wav_spec)
            .map_err(|err| AudioError::Wav(err.to_string()))?;

        Ok(Self {
            writer,
            spec,
            samples_written: 0,
            path: path.to_path_buf(),
        })
    }

    /// Writes normalized f32 samples (range `[-1.0, 1.0]`), converting to
    /// 16-bit PCM.
    pub fn write(&mut self, samples: &[f32]) -> Result<(), AudioError> {
        for &sample in samples {
            let clamped = sample.clamp(-1.0, 1.0);
            let pcm = (clamped * i16::MAX as f32) as i16;
            self.writer
                .write_sample(pcm)
                .map_err(|err| AudioError::Wav(err.to_string()))?;
        }
        self.samples_written += samples.len() as u64;
        Ok(())
    }

    /// Flushes and closes the WAV file, returning summary statistics.
    pub fn finalize(self) -> Result<RecordingStats, AudioError> {
        let channels = self.spec.channels.max(1) as u64;
        let frames = self.samples_written / channels;
        let duration = Duration::from_secs_f64(frames as f64 / self.spec.sample_rate as f64);
        let path = self.path.clone();

        self.writer
            .finalize()
            .map_err(|err| AudioError::Wav(err.to_string()))?;

        Ok(RecordingStats {
            frames,
            duration,
            path,
        })
    }
}
