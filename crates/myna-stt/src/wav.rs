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
    let mono = downmix_to_mono(samples, spec.channels as usize);

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
    /// Sourced from the header's *declared* data-chunk length — callers
    /// pre-sizing allocations from it must clamp against the file's real
    /// size first (see [`crate::diarize::reservation_frames`]), since a
    /// corrupt or hostile user-imported file can declare far more frames
    /// than it holds.
    pub fn total_frames(&self) -> u64 {
        self.total_frames
    }

    /// Bytes one frame occupies in the file's data chunk (channels ×
    /// sample width), used to bound a header-declared frame count against
    /// the file's actual byte size.
    pub fn bytes_per_frame(&self) -> u64 {
        u64::from(self.spec.channels) * u64::from(self.spec.bits_per_sample) / 8
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

        Ok(Some(downmix_to_mono(samples, channels)))
    }
}

/// Averages interleaved multi-channel samples down to mono. For mono input
/// (`channels <= 1`) the caller's buffer is moved out unchanged — no copy —
/// so zero-copy passthrough holds for whole-file and block-wise reads alike.
fn downmix_to_mono(samples: Vec<f32>, channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return samples;
    }

    samples
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_mono16_wav(path: &Path, sample_rate: u32, samples: &[i16]) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("create wav");
        for &s in samples {
            writer.write_sample(s).expect("write sample");
        }
        writer.finalize().expect("finalize wav");
    }

    fn write_stereo16_wav(path: &Path, sample_rate: u32, frames: &[(i16, i16)]) {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("create wav");
        for &(l, r) in frames {
            writer.write_sample(l).expect("write left sample");
            writer.write_sample(r).expect("write right sample");
        }
        writer.finalize().expect("finalize wav");
    }

    fn write_mono_f32_wav(path: &Path, sample_rate: u32, samples: &[f32]) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("create wav");
        for &s in samples {
            writer.write_sample(s).expect("write sample");
        }
        writer.finalize().expect("finalize wav");
    }

    #[test]
    fn block_reader_passes_through_16khz_mono_samples_unchanged() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("mono16k.wav");
        let raw_i16: Vec<i16> = vec![
            0, 8192, -8192, 16384, -16384, 100, -100, 32767, -32768, 5000,
        ];
        write_mono16_wav(&path, 16_000, &raw_i16);

        // Act
        let mut reader = WavBlockReader::open(&path).expect("open");
        let mut collected = Vec::new();
        while let Some(block) = reader.next_block(4).expect("next_block") {
            assert!(block.len() <= 4, "block must never exceed block_frames");
            collected.extend(block);
        }

        // Assert
        assert_eq!(reader.sample_rate(), 16_000);
        assert_eq!(reader.total_frames(), raw_i16.len() as u64);
        let expected: Vec<f32> = raw_i16.iter().map(|&s| s as f32 / 32_768.0).collect();
        assert_eq!(collected, expected);
    }

    #[test]
    fn block_reader_reports_native_rate_and_downmixes_stereo_to_mono() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("stereo48k.wav");
        let frames: Vec<(i16, i16)> = vec![
            (1000, -1000),
            (2000, 6000),
            (-32768, 32767),
            (0, 0),
            (500, 1500),
        ];
        write_stereo16_wav(&path, 48_000, &frames);

        // Act
        let mut reader = WavBlockReader::open(&path).expect("open");
        let mut collected = Vec::new();
        while let Some(block) = reader.next_block(2).expect("next_block") {
            collected.extend(block);
        }

        // Assert
        assert_eq!(
            reader.sample_rate(),
            48_000,
            "must report the file's native rate — this reader never resamples"
        );
        assert_eq!(reader.total_frames(), frames.len() as u64);
        let expected: Vec<f32> = frames
            .iter()
            .map(|&(l, r)| ((l as f32 / 32_768.0) + (r as f32 / 32_768.0)) / 2.0)
            .collect();
        assert_eq!(collected, expected);
    }

    #[test]
    fn block_reader_concatenated_output_matches_read_wav_to_f32() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("mixed.wav");
        let frames: Vec<(i16, i16)> = (0..13i16)
            .map(|i| (i * 1000 - 6000, -(i * 500) + 3000))
            .collect();
        write_stereo16_wav(&path, 44_100, &frames);
        let (expected_samples, expected_rate) =
            read_wav_to_f32(&path).expect("read_wav_to_f32 baseline");

        // Act
        let mut reader = WavBlockReader::open(&path).expect("open");
        let mut collected = Vec::new();
        while let Some(block) = reader.next_block(5).expect("next_block") {
            collected.extend(block);
        }

        // Assert
        assert_eq!(reader.sample_rate(), expected_rate);
        assert_eq!(
            collected, expected_samples,
            "block-reader output must equal read_wav_to_f32 sample-for-sample"
        );
    }

    #[test]
    fn block_reader_reads_ieee_float_pcm_wav() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("float.wav");
        let samples: Vec<f32> = vec![0.0, 0.125, -0.25, 0.999, -0.999, 0.333, -0.5];
        write_mono_f32_wav(&path, 16_000, &samples);

        // Act
        let mut reader = WavBlockReader::open(&path).expect("open");
        let mut collected = Vec::new();
        while let Some(block) = reader.next_block(3).expect("next_block") {
            collected.extend(block);
        }

        // Assert
        assert_eq!(collected, samples);
    }

    #[test]
    fn block_reader_final_block_is_shorter_when_frame_count_is_not_a_multiple() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("short_tail.wav");
        let raw_i16: Vec<i16> = (0..10i16).map(|i| i * 100).collect(); // 10 frames

        write_mono16_wav(&path, 16_000, &raw_i16);

        // Act
        let mut reader = WavBlockReader::open(&path).expect("open");
        let mut blocks = Vec::new();
        while let Some(block) = reader.next_block(4).expect("next_block") {
            blocks.push(block);
        }

        // Assert
        assert_eq!(
            blocks.len(),
            3,
            "10 frames at block_frames=4 must yield 3 blocks (4, 4, 2)"
        );
        assert_eq!(blocks[0].len(), 4);
        assert_eq!(blocks[1].len(), 4);
        assert_eq!(
            blocks[2].len(),
            2,
            "final block must be shorter than block_frames"
        );
        assert!(
            reader
                .next_block(4)
                .expect("next_block after eof")
                .is_none(),
            "must return Ok(None) once every frame has been yielded"
        );
    }

    #[test]
    fn total_frames_counts_frames_not_interleaved_samples() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("count_check.wav");
        let frame_count: i16 = 37;
        let frames: Vec<(i16, i16)> = (0..frame_count).map(|i| (i, -i)).collect();
        write_stereo16_wav(&path, 48_000, &frames);

        // Act
        let reader = WavBlockReader::open(&path).expect("open");

        // Assert
        assert_eq!(
            reader.total_frames(),
            frame_count as u64,
            "must report frame count, not interleaved sample count (2x for stereo)"
        );
    }

    #[test]
    fn downmix_to_mono_returns_the_input_allocation_for_mono_audio() {
        // Production diarization reads 16 kHz mono tracks: for `channels <= 1`
        // a downmix is a pure passthrough, so any fresh allocation is a
        // redundant full-file copy that doubles peak memory for zero
        // transformation. The mono path must hand back the caller's own
        // buffer — same pointer, same capacity — not a copy.
        let samples: Vec<f32> = (0..1024).map(|i| (i % 7) as f32 * 0.1).collect();
        let input_ptr = samples.as_ptr();
        let input_len = samples.len();
        let input_cap = samples.capacity();
        let expected = samples.clone();

        let mono = downmix_to_mono(samples, 1);
        assert_eq!(mono.len(), input_len);
        assert_eq!(mono, expected);
        assert!(
            std::ptr::eq(mono.as_ptr(), input_ptr),
            "mono passthrough must reuse the caller's buffer, got a fresh allocation"
        );
        assert_eq!(
            mono.capacity(),
            input_cap,
            "mono passthrough must not reallocate"
        );
    }

    #[test]
    fn open_on_a_missing_path_returns_an_error_not_a_panic() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("does-not-exist.wav");

        // Act
        let result = WavBlockReader::open(&missing);

        // Assert
        assert!(
            result.is_err(),
            "opening a missing path must error, not panic"
        );
    }
}
