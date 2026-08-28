//! Integration tests for `WavRecorder`. No real audio device is opened
//! anywhere in this file.

use myna_audio::{RecordingSpec, WavRecorder};

#[test]
fn wav_round_trip_preserves_spec_and_sample_count() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir creates");
    let path = dir.path().join("recording.wav");
    let spec = RecordingSpec {
        sample_rate: 16_000,
        channels: 1,
    };
    let samples: Vec<f32> = vec![0.0, 0.25, -0.25, 0.5, -0.5, 1.0, -1.0];

    // Act
    let mut recorder = WavRecorder::create(&path, spec).expect("recorder creates");
    recorder.write(&samples).expect("write succeeds");
    let stats = recorder.finalize().expect("finalize succeeds");

    let mut reader = hound::WavReader::open(&path).expect("reader opens");
    let read_spec = reader.spec();
    let read_samples: Vec<i16> = reader
        .samples::<i16>()
        .collect::<Result<Vec<_>, _>>()
        .expect("samples decode");

    // Assert
    assert_eq!(read_spec.sample_rate, spec.sample_rate);
    assert_eq!(read_spec.channels, spec.channels);
    assert_eq!(read_spec.bits_per_sample, 16);
    assert_eq!(read_samples.len(), samples.len());
    assert_eq!(stats.frames, samples.len() as u64);
    assert_eq!(stats.path, path);
}
