//! Cross-crate `myna-audio` <-> `myna-stt` pipeline tests: resampling,
//! WAV recording, and level metering.
//!
//! Every test here runs unconditionally — none of it touches a model, so
//! there is nothing to skip.

use myna_audio::{rms, RecordingSpec, Resampler, WavRecorder};
use myna_stt::read_wav_to_f32;

/// Number of frames of a synthesized 48 kHz test clip.
const INPUT_FRAMES_48K: usize = 48_000;
/// Source sample rate for the resample test.
const SOURCE_SAMPLE_RATE_HZ: u32 = 48_000;
/// Target sample rate every capture path normalizes to.
const TARGET_SAMPLE_RATE_HZ: u32 = 16_000;
/// Acceptable relative error between an expected and actual output length
/// (1%).
const LENGTH_TOLERANCE_RATIO: f64 = 0.01;

/// Number of mono frames written to the WAV roundtrip fixture (0.5 seconds
/// at 16 kHz).
const RECORDED_FRAME_COUNT: usize = 8_000;

/// Tolerance used when comparing floating-point RMS results.
const RMS_EPSILON: f32 = 1e-3;
/// Number of samples used for the sine-wave RMS fixture.
const SINE_SAMPLE_COUNT: usize = 10_000;

fn sine_wave(amplitude: f32, sample_count: usize, angular_step: f32) -> Vec<f32> {
    (0..sample_count)
        .map(|i| amplitude * (i as f32 * angular_step).sin())
        .collect()
}

#[test]
fn resamples_48khz_sine_to_16khz_within_one_percent_of_expected_length() {
    // Arrange
    let mut resampler = Resampler::new(SOURCE_SAMPLE_RATE_HZ, TARGET_SAMPLE_RATE_HZ)
        .expect("resampler constructs for a supported rate pair");
    let input = sine_wave(1.0, INPUT_FRAMES_48K, 0.01);
    let expected_len =
        INPUT_FRAMES_48K as f64 * TARGET_SAMPLE_RATE_HZ as f64 / SOURCE_SAMPLE_RATE_HZ as f64;

    // Act
    let mut output = resampler.process(&input);
    output.extend(resampler.flush());

    // Assert
    let actual_len = output.len() as f64;
    let relative_error = (actual_len - expected_len).abs() / expected_len;
    assert!(
        relative_error <= LENGTH_TOLERANCE_RATIO,
        "expected ~{expected_len} output frames, got {actual_len} (relative error {relative_error})"
    );
}

#[test]
fn wav_recorder_roundtrip_produces_16khz_mono_pcm_matching_frame_count() {
    // Arrange
    let temp_dir = tempfile::tempdir().expect("temp dir creates");
    let wav_path = temp_dir.path().join("roundtrip.wav");
    let spec = RecordingSpec {
        sample_rate: TARGET_SAMPLE_RATE_HZ,
        channels: 1,
    };
    let mut recorder = WavRecorder::create(&wav_path, spec).expect("recorder creates");
    let samples = sine_wave(0.25, RECORDED_FRAME_COUNT, 0.05);

    // Act
    recorder.write(&samples).expect("write succeeds");
    let stats = recorder.finalize().expect("finalize succeeds");
    let (read_back, sample_rate) = read_wav_to_f32(&wav_path).expect("read back succeeds");

    // Assert
    assert_eq!(stats.frames, RECORDED_FRAME_COUNT as u64);
    assert_eq!(sample_rate, TARGET_SAMPLE_RATE_HZ);
    assert_eq!(read_back.len(), RECORDED_FRAME_COUNT);
}

#[test]
fn rms_of_silence_is_approximately_zero() {
    // Arrange
    let silence = vec![0.0f32; 1_000];

    // Act
    let level = rms(&silence);

    // Assert
    assert!((level - 0.0).abs() < RMS_EPSILON);
}

#[test]
fn rms_of_half_amplitude_sine_is_approximately_0_354() {
    // Arrange
    let sine = sine_wave(0.5, SINE_SAMPLE_COUNT, 0.1);

    // Act
    let level = rms(&sine);

    // Assert
    assert!(
        (level - 0.354).abs() < RMS_EPSILON,
        "expected rms ~= 0.354, got {level}"
    );
}
