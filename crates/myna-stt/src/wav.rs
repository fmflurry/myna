//! WAV file loading for offline decode.

use std::path::Path;

use hound::{SampleFormat, WavReader};

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

/// Reads every sample as `f32`, normalizing integer PCM in place.
fn read_samples<R: std::io::Read>(
    reader: &mut WavReader<R>,
    format: SampleFormat,
    bits_per_sample: u16,
) -> Result<Vec<f32>, SttError> {
    match format {
        SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<Vec<f32>, _>>()
            .map_err(|err| SttError::Wav(err.to_string())),
        SampleFormat::Int => {
            let scale = (1i64 << (bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<Result<Vec<f32>, _>>()
                .map_err(|err| SttError::Wav(err.to_string()))
        }
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
