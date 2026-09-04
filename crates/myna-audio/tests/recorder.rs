//! Integration tests for `WavRecorder`. No real audio device is opened
//! anywhere in this file.

use myna_audio::{RecordingSpec, SegmentedWavRecorder, WavRecorder};

const PCM_BYTES_PER_MONO_FRAME: u64 = 2;

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

#[test]
fn segmented_recorder_rotates_before_its_data_ceiling_and_finalizes_every_part() {
    // Arrange: the eight-byte ceiling holds exactly four 16-bit mono frames.
    let dir = tempfile::tempdir().expect("tempdir creates");
    let path = dir.path().join("recording.wav");
    let spec = RecordingSpec {
        sample_rate: 16_000,
        channels: 1,
    };
    let samples = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    let expected_parts = [
        path.clone(),
        dir.path().join("recording.part-0002.wav"),
        dir.path().join("recording.part-0003.wav"),
    ];

    // Act: one write is deliberately larger than a part, so it must be split.
    let mut recorder = SegmentedWavRecorder::create(&path, spec, 8)
        .expect("segmented recorder creates with a test-sized data ceiling");
    recorder
        .write(&samples)
        .expect("oversized write rotates safely");
    let stats = recorder.finalize().expect("all parts finalize");

    // Assert: the base name belongs to the first part and each completed part
    // is an independently readable classic WAV, never larger than its ceiling.
    assert_eq!(stats.path, path);
    assert_eq!(stats.frames, samples.len() as u64);
    assert_eq!(stats.bytes, samples.len() as u64 * PCM_BYTES_PER_MONO_FRAME);
    assert_eq!(stats.parts, expected_parts.len() as u64);

    for (part_path, expected_frames) in expected_parts.iter().zip([4, 4, 2]) {
        let mut reader = hound::WavReader::open(part_path).expect("completed part is valid WAV");
        let part_samples = reader
            .samples::<i16>()
            .collect::<Result<Vec<_>, _>>()
            .expect("part samples decode");
        assert_eq!(part_samples.len(), expected_frames);
        assert!(
            std::fs::metadata(part_path)
                .expect("part metadata reads")
                .len()
                <= 44 + expected_frames as u64 * PCM_BYTES_PER_MONO_FRAME,
            "part must rotate before exceeding the PCM ceiling"
        );
    }
}

#[cfg(unix)]
#[test]
fn segmented_recorder_keeps_each_rotated_part_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    // Arrange
    let dir = tempfile::tempdir().expect("tempdir creates");
    let path = dir.path().join("private.wav");
    let spec = RecordingSpec {
        sample_rate: 16_000,
        channels: 1,
    };

    // Act
    let mut recorder = SegmentedWavRecorder::create(&path, spec, 4).expect("recorder creates");
    recorder
        .write(&[0.0, 0.1, 0.2, 0.3, 0.4])
        .expect("write rotates");
    recorder.finalize().expect("parts finalize");

    // Assert
    for part in [
        path.clone(),
        dir.path().join("private.part-0002.wav"),
        dir.path().join("private.part-0003.wav"),
    ] {
        assert_eq!(
            std::fs::metadata(part)
                .expect("part metadata reads")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn segmented_recorder_refuses_a_ceiling_that_cannot_hold_one_complete_frame() {
    // Arrange: stereo PCM frames are four bytes and must never be split.
    let dir = tempfile::tempdir().expect("tempdir creates");
    let path = dir.path().join("stereo.wav");
    let stereo = RecordingSpec {
        sample_rate: 16_000,
        channels: 2,
    };

    // Act / Assert: surface a normal error rather than emitting a malformed,
    // frame-truncated WAV or panicking during a later write.
    assert!(SegmentedWavRecorder::create(&path, stereo, 3).is_err());
}

#[test]
fn segmented_recorder_never_splits_an_oversized_stereo_write_mid_frame() {
    // Arrange: ten bytes cannot hold 2.5 four-byte stereo frames, so every
    // part must stop at two frames (eight bytes) and carry no half-frame.
    let dir = tempfile::tempdir().expect("tempdir creates");
    let path = dir.path().join("stereo.wav");
    let stereo = RecordingSpec {
        sample_rate: 16_000,
        channels: 2,
    };
    let interleaved_samples = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

    // Act
    let mut recorder = SegmentedWavRecorder::create(&path, stereo, 10).expect("recorder creates");
    recorder
        .write(&interleaved_samples)
        .expect("oversized stereo write splits at frame boundaries");
    recorder.finalize().expect("parts finalize");

    // Assert
    for (part, expected_frames) in [
        (path.clone(), 2),
        (dir.path().join("stereo.part-0002.wav"), 2),
        (dir.path().join("stereo.part-0003.wav"), 1),
    ] {
        let mut reader = hound::WavReader::open(&part).expect("part is a valid WAV");
        let samples = reader
            .samples::<i16>()
            .collect::<Result<Vec<_>, _>>()
            .expect("part samples decode");
        let data_bytes = std::fs::metadata(part).expect("part metadata reads").len() - 44;
        assert_eq!(samples.len(), expected_frames * 2);
        assert_eq!(data_bytes, expected_frames as u64 * 4);
        assert_eq!(data_bytes % 4, 0, "part has complete stereo frames only");
    }
}

#[test]
fn segmented_recorder_returns_a_write_error_when_the_next_part_cannot_be_created() {
    // Arrange: a directory deliberately occupies the next part path.
    let dir = tempfile::tempdir().expect("tempdir creates");
    let path = dir.path().join("recording.wav");
    std::fs::create_dir(path.with_file_name("recording.part-0002.wav"))
        .expect("reserve next part path with a directory");
    let spec = RecordingSpec {
        sample_rate: 16_000,
        channels: 1,
    };
    let mut recorder = SegmentedWavRecorder::create(&path, spec, 4).expect("first part creates");
    recorder.write(&[0.0, 0.1]).expect("first part fills");

    // Act / Assert: rotation failure is reported to the caller, not swallowed.
    assert!(recorder.write(&[0.2]).is_err());
}
