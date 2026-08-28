//! WAV file loading for offline decode.

use std::path::Path;

use hound::{SampleFormat, WavReader, WavSpec};

use crate::error::SttError;

/// Reads a WAV file into mono `f32` PCM samples, returning `(samples,
/// sample_rate)`.
///
/// Multi-channel files are downmixed to mono by averaging channels. Integer
/// PCM samples are normalized to `[-1.0, 1.0]` by dividing by
/// `2^(bits_per_sample - 1)`; float PCM samples pass through unchanged.
pub fn read_wav_to_f32(path: &Path) -> Result<(Vec<f32>, u32), SttError> {
    let mut reader = WavReader::open(path).map_err(|err| SttError::Wav(err.to_string()))?;
    let spec = reader.spec();

    let samples = read_samples(&mut reader, spec.sample_format, spec.bits_per_sample)?;
    let mono = downmix_to_mono(&samples, spec.channels as usize);

    Ok((mono, spec.sample_rate))
}

/// Reads every remaining sample as `f32`, normalizing integer PCM in place.
fn read_samples<R: std::io::Read>(
    reader: &mut WavReader<R>,
    format: SampleFormat,
    bits_per_sample: u16,
) -> Result<Vec<f32>, SttError> {
    read_samples_limited(reader, format, bits_per_sample, usize::MAX)
}

/// Reads up to `max_samples` remaining interleaved samples as `f32`,
/// normalizing integer PCM in place. [`read_samples`] delegates here with
/// an unbounded limit so both the whole-file and block-wise readers share
/// the exact same normalization logic.
fn read_samples_limited<R: std::io::Read>(
    reader: &mut WavReader<R>,
    format: SampleFormat,
    bits_per_sample: u16,
    max_samples: usize,
) -> Result<Vec<f32>, SttError> {
    match format {
        SampleFormat::Float => reader
            .samples::<f32>()
            .take(max_samples)
            .collect::<Result<Vec<f32>, _>>()
            .map_err(|err| SttError::Wav(err.to_string())),
        SampleFormat::Int => {
            let scale = (1i64 << (bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .take(max_samples)
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<Result<Vec<f32>, _>>()
                .map_err(|err| SttError::Wav(err.to_string()))
        }
    }
}

/// Reads a WAV file one bounded block of frames at a time, for callers that
/// want to feed a file through a streaming pipeline (e.g. [`crate::stream`])
/// without loading the whole file into memory up front.
///
/// Applies the exact same int/float normalization and channel downmixing as
/// [`read_wav_to_f32`] — see [`read_samples_limited`] and [`downmix_to_mono`]
/// — so block-wise output is byte-for-byte identical to reading the whole
/// file at once. Never resamples: [`Self::sample_rate`] always reports the
/// file's native rate.
pub struct WavBlockReader {
    reader: WavReader<std::io::BufReader<std::fs::File>>,
    spec: WavSpec,
    total_frames: u64,
}

impl WavBlockReader {
    /// Opens `path` for block-wise reading.
    pub fn open(path: &Path) -> Result<Self, SttError> {
        let reader = WavReader::open(path).map_err(|err| SttError::Wav(err.to_string()))?;
        let spec = reader.spec();
        // `WavReader::duration()` returns the frame count (not the
        // interleaved sample count), computed from the data chunk length at
        // open time — unaffected by subsequent reads.
        let total_frames = reader.duration() as u64;

        Ok(Self {
            reader,
            spec,
            total_frames,
        })
    }

    /// The file's native sample rate. Never resampled.
    pub fn sample_rate(&self) -> u32 {
        self.spec.sample_rate
    }

    /// Total number of frames in the file, established at [`Self::open`].
    pub fn total_frames(&self) -> u64 {
        self.total_frames
    }

    /// Reads up to `block_frames` frames, downmixed to mono. Returns
    /// `Ok(None)` once every frame has already been yielded. The final
    /// block may be shorter than `block_frames` if the frame count isn't an
    /// exact multiple.
    pub fn next_block(&mut self, block_frames: usize) -> Result<Option<Vec<f32>>, SttError> {
        let channels = self.spec.channels as usize;
        let max_samples = block_frames * channels;

        let samples = read_samples_limited(
            &mut self.reader,
            self.spec.sample_format,
            self.spec.bits_per_sample,
            max_samples,
        )?;

        if samples.is_empty() {
            return Ok(None);
        }

        Ok(Some(downmix_to_mono(&samples, channels)))
    }
}

/// Averages interleaved multi-channel samples down to mono. A no-op for
/// mono input.
fn downmix_to_mono(samples: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }

    samples
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}
