//! WAV recording of normalized f32 audio to 16-bit PCM files.

use std::fs::File;
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

/// Opens `path` for writing (creating or truncating it), restricting the
/// file to owner-only access (`0600`) on Unix from the moment it is
/// created. Non-Unix targets fall back to the platform default permissions
/// -- Myna is macOS-first and Windows/Linux ACL handling is deferred (see
/// `docs/stack-proposal.md`).
#[cfg(unix)]
fn open_0600(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn open_0600(path: &Path) -> std::io::Result<File> {
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
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
    ///
    /// Opens the file itself (via [`open_0600`], restricting it to
    /// owner-only access on Unix from the moment it is created) rather than
    /// using `hound::WavWriter::create`, which would create the file at the
    /// platform-default (world/group-readable) permissions before any
    /// audio is ever written to it -- `~/myna` is not a TCC-protected
    /// location, so that window is the difference between a meeting
    /// recording being readable only by its owner and readable by any
    /// unsandboxed process on the same machine.
    pub fn create(path: &Path, spec: RecordingSpec) -> Result<Self, AudioError> {
        let wav_spec = hound::WavSpec {
            channels: spec.channels,
            sample_rate: spec.sample_rate,
            bits_per_sample: BITS_PER_SAMPLE,
            sample_format: hound::SampleFormat::Int,
        };

        let file = open_0600(path).map_err(|err| AudioError::Wav(err.to_string()))?;
        let buffered = std::io::BufWriter::new(file);
        let writer = hound::WavWriter::new(buffered, wav_spec)
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

/// Byte length of the canonical 44-byte PCM WAV header `hound` writes for
/// a plain (non-extensible) `WavSpec`: 12 bytes of RIFF/WAVE framing, a
/// 24-byte `fmt ` chunk (8 header + 16 body), and an 8-byte `data` chunk
/// header.
const WAV_HEADER_BYTES: usize = 44;
/// Offset of the RIFF chunk size (`file length - 8`) within the header.
const RIFF_SIZE_OFFSET: usize = 4;
/// Offset of the data chunk size within the header.
const DATA_SIZE_OFFSET: usize = 40;

fn read_u32_le(header: &[u8; WAV_HEADER_BYTES], offset: usize) -> u32 {
    let bytes: [u8; 4] = header[offset..offset + 4]
        .try_into()
        .expect("offsets are bounded by the 44-byte header");
    u32::from_le_bytes(bytes)
}

fn read_u16_le(header: &[u8; WAV_HEADER_BYTES], offset: usize) -> u16 {
    let bytes: [u8; 2] = header[offset..offset + 2]
        .try_into()
        .expect("offsets are bounded by the 44-byte header");
    u16::from_le_bytes(bytes)
}

/// Parses the sample rate and channel count out of a canonical 44-byte
/// PCM WAV header, rejecting anything else.
///
/// Recognized as canonical (and therefore safe to size-patch): `RIFF` +
/// `WAVE` magics, a `fmt ` chunk declaring exactly 16 bytes of body (the
/// plain `WAVEFORMAT` layout `hound` writes — a 40-byte
/// `WAVEFORMATEXTENSIBLE` is *not* canonical and is refused), PCM format
/// tag 1, 16-bit samples, and a `data` chunk header starting at exactly
/// offset 36. Zero-valued rate/channels are refused too (frames and
/// duration would divide by zero).
fn parse_canonical_pcm_header(header: &[u8; WAV_HEADER_BYTES]) -> Result<(u32, u16), AudioError> {
    let refused =
        |reason: &str| AudioError::Wav(format!("not a canonical 44-byte PCM WAV header: {reason}"));
    if &header[0..4] != b"RIFF" {
        return Err(refused("missing RIFF magic"));
    }
    if &header[8..12] != b"WAVE" {
        return Err(refused("missing WAVE magic"));
    }
    if &header[12..16] != b"fmt " {
        return Err(refused("missing fmt chunk magic"));
    }
    if read_u32_le(header, 16) != 16 {
        return Err(refused("fmt chunk size is not the canonical 16 bytes"));
    }
    if read_u16_le(header, 20) != 1 {
        return Err(refused("audio format tag is not PCM"));
    }
    let channels = read_u16_le(header, 22);
    let sample_rate = read_u32_le(header, 24);
    if read_u16_le(header, 34) != BITS_PER_SAMPLE {
        return Err(refused("sample depth is not 16-bit"));
    }
    if &header[36..40] != b"data" {
        return Err(refused("missing data chunk magic at offset 36"));
    }
    if channels == 0 || sample_rate == 0 {
        return Err(refused("zero channels or sample rate"));
    }
    Ok((sample_rate, channels))
}

/// Repairs the two size fields of a canonical 44-byte PCM WAV header that
/// a crashed (never-finalized) recording left behind.
///
/// `hound::WavWriter` writes the RIFF chunk size (offset 4) and the data
/// chunk size (offset 40) as **zero placeholders** and patches them only
/// in `finalize()` — so a process killed mid-recording leaves every sample
/// it had already written on disk, but a header claiming zero audio. This
/// recomputes both fields from the file's actual length (`file_len - 44`
/// bytes of data), patches them in place as little-endian `u32`, and
/// returns the recovered [`RecordingStats`] derived from the header's own
/// sample rate, channel count, and 16-bit depth.
///
/// A header that is already correct is returned untouched (idempotent —
/// no write happens at all). A header this function cannot fully
/// understand is refused with [`AudioError::Wav`] **without writing a
/// single byte**, so an unfamiliar layout is never corrupted further.
///
/// A recording whose data exceeds the ~4 GiB a canonical 32-bit WAV
/// header can describe is unrepairable in this format: the size fields
/// would silently truncate, so the function returns [`AudioError::Wav`]
/// instead and the caller (startup recovery) logs and skips the file.
pub fn repair_wav_sizes(path: &Path) -> Result<RecordingStats, AudioError> {
    use std::io::{Read, Seek, SeekFrom, Write};

    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|err| AudioError::Wav(format!("failed to open WAV file for repair: {err}")))?;

    let mut header = [0_u8; WAV_HEADER_BYTES];
    if file.read_exact(&mut header).is_err() {
        return Err(AudioError::Wav(
            "file is shorter than the canonical 44-byte WAV header".to_string(),
        ));
    }
    let (sample_rate, channels) = parse_canonical_pcm_header(&header)?;

    let file_len = file
        .metadata()
        .map_err(|err| AudioError::Wav(format!("failed to stat WAV file for repair: {err}")))?
        .len();
    let data_bytes = file_len - WAV_HEADER_BYTES as u64;
    let Ok(data_size) = u32::try_from(data_bytes) else {
        return Err(AudioError::Wav(
            "data chunk exceeds the 4 GiB a 32-bit WAV header can describe".to_string(),
        ));
    };
    let Ok(riff_size) = u32::try_from(data_bytes + (WAV_HEADER_BYTES as u64 - 8)) else {
        return Err(AudioError::Wav(
            "file exceeds the 4 GiB a 32-bit WAV header can describe".to_string(),
        ));
    };

    let header_riff_size = read_u32_le(&header, RIFF_SIZE_OFFSET);
    let header_data_size = read_u32_le(&header, DATA_SIZE_OFFSET);
    if header_riff_size != riff_size || header_data_size != data_size {
        file.seek(SeekFrom::Start(RIFF_SIZE_OFFSET as u64))?;
        file.write_all(&riff_size.to_le_bytes())?;
        file.seek(SeekFrom::Start(DATA_SIZE_OFFSET as u64))?;
        file.write_all(&data_size.to_le_bytes())?;
        file.flush()?;
    }

    let bytes_per_frame = u64::from(channels) * (u64::from(BITS_PER_SAMPLE) / 8);
    let frames = data_bytes / bytes_per_frame;
    let duration = Duration::from_secs_f64(frames as f64 / f64::from(sample_rate));
    Ok(RecordingStats {
        frames,
        duration,
        path: path.to_path_buf(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm_spec(channels: u16, sample_rate: u32) -> hound::WavSpec {
        hound::WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        }
    }

    /// Simulates a process killed mid-recording: every sample reaches the
    /// disk (a plain unbuffered `File` writes each `write_sample` straight
    /// to the OS), but the header patch `finalize()` (or `hound`'s `Drop`)
    /// would have applied never runs, because the writer is
    /// `mem::forget`-ed.
    fn write_crashed_wav(path: &Path, spec: hound::WavSpec, frames: usize) {
        let file = std::fs::File::create(path).expect("create crashed wav");
        let mut writer = hound::WavWriter::new(file, spec).expect("hound writer");
        for frame in 0..frames {
            for _ in 0..spec.channels {
                writer
                    .write_sample((frame % 100) as i16)
                    .expect("write sample");
            }
        }
        std::mem::forget(writer);
    }

    #[test]
    fn repair_wav_sizes_recovers_a_crashed_unfinalized_recording() {
        // Arrange: 3 s of 16 kHz mono audio written by a "crashed" writer.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("track-mic.wav");
        let frames = 16_000 * 3;
        write_crashed_wav(&path, pcm_spec(1, 16_000), frames);

        // The pre-fix failure mode, pinned directly: an unfinalized header
        // declares zero data bytes, so `hound` reads the file as empty even
        // though every sample is on disk. (Confirmed: without
        // `repair_wav_sizes` the file stays permanently unreadable — the
        // assertions below fail against the pre-fix behavior, which had no
        // repair at all.)
        let broken = hound::WavReader::open(&path).expect("open crashed wav");
        assert_eq!(
            broken.len(),
            0,
            "an unfinalized header must read as empty — this is the bug repair_wav_sizes fixes"
        );

        // Act
        let stats = repair_wav_sizes(&path).expect("repair should succeed");

        // Assert: stats derived from the header's own rate/channels...
        assert_eq!(stats.frames as usize, frames);
        assert_eq!(stats.duration, Duration::from_secs(3));
        assert_eq!(stats.path, path);

        // ...and the file is now genuinely readable end to end.
        let mut reader = hound::WavReader::open(&path).expect("reopen repaired wav");
        assert_eq!(
            reader.len() as usize,
            frames,
            "hound must read the exact frame count after repair"
        );
        assert_eq!(reader.samples::<i16>().count(), frames);
    }

    #[test]
    fn repair_wav_sizes_is_idempotent_and_never_rewrites_a_correct_header() {
        // Arrange: a normally finalized stereo 48 kHz recording.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("audio.wav");
        let spec = RecordingSpec {
            sample_rate: 48_000,
            channels: 2,
        };
        let mut recorder = WavRecorder::create(&path, spec).expect("create recorder");
        recorder
            .write(&vec![0.25; 48_000 * 2])
            .expect("write one second of stereo");
        let finalized = recorder.finalize().expect("finalize");
        let bytes_before = std::fs::read(&path).expect("read bytes");

        // Act
        let stats = repair_wav_sizes(&path).expect("repair of a healthy file must succeed");

        // Assert: same stats (frames/duration derived from the header,
        // matching what finalize reported), and the file is byte-identical
        // — the already-correct path performs no write at all.
        assert_eq!(stats.frames, finalized.frames);
        assert_eq!(stats.duration, finalized.duration);
        let bytes_after = std::fs::read(&path).expect("read bytes again");
        assert_eq!(
            bytes_before, bytes_after,
            "an already-correct header must not be rewritten"
        );
    }

    #[test]
    fn repair_wav_sizes_bails_without_writing_on_a_non_extensible_unrecognized_header() {
        // Arrange: a crashed file whose `fmt ` chunk size is tampered to 40
        // (a WAVEFORMATEXTENSIBLE layout this function must refuse to
        // size-patch, since its data chunk does not start at offset 36).
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("weird.wav");
        write_crashed_wav(&path, pcm_spec(1, 16_000), 100);
        let mut bytes = std::fs::read(&path).expect("read");
        bytes[16..20].copy_from_slice(&40_u32.to_le_bytes());
        std::fs::write(&path, &bytes).expect("tamper fmt chunk size");

        // Act
        let err = repair_wav_sizes(&path).expect_err("an extended fmt chunk must be refused");

        // Assert
        assert!(matches!(err, AudioError::Wav(_)), "got: {err:?}");
        let bytes_after = std::fs::read(&path).expect("read again");
        assert_eq!(
            bytes_after, bytes,
            "a refused file must be left byte-for-byte untouched"
        );
    }

    #[test]
    fn repair_wav_sizes_bails_on_garbage_and_truncated_files() {
        let dir = tempfile::tempdir().expect("tempdir");

        // Garbage magic.
        let garbage = dir.path().join("garbage.wav");
        std::fs::write(&garbage, b"PK\x03\x04 definitely not a wav file at all").expect("write");
        let before = std::fs::read(&garbage).expect("read");
        assert!(matches!(
            repair_wav_sizes(&garbage),
            Err(AudioError::Wav(_))
        ));
        assert_eq!(std::fs::read(&garbage).expect("read again"), before);

        // Shorter than the 44-byte header.
        let short = dir.path().join("short.wav");
        std::fs::write(&short, b"RIFF").expect("write");
        assert!(matches!(repair_wav_sizes(&short), Err(AudioError::Wav(_))));
    }

    #[test]
    fn repair_wav_sizes_derives_stats_from_the_headers_own_rate_and_channels() {
        // A 48 kHz stereo crash must report frames per channel-pair and a
        // duration computed at 48 kHz — not the 16 kHz mono STT spec.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("audio.wav");
        write_crashed_wav(&path, pcm_spec(2, 48_000), 48_000);

        let stats = repair_wav_sizes(&path).expect("repair");

        assert_eq!(stats.frames, 48_000);
        assert_eq!(stats.duration, Duration::from_secs(1));
    }
}
