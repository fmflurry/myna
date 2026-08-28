//! Integration tests for resampling and downmixing. No real audio device is
//! opened anywhere in this file.

use myna_audio::{downmix_to_mono, Resampler};

/// Number of frames of a 48 kHz test clip used across the resample tests.
const INPUT_FRAMES_48K: usize = 48_000;

/// Acceptable relative error between an expected and actual output length,
/// as a fraction (1%).
const LENGTH_TOLERANCE_RATIO: f64 = 0.01;

#[test]
fn resamples_48khz_to_16khz_within_one_percent_of_expected_length() {
    // Arrange
    let mut resampler = Resampler::new(48_000, 16_000).expect("resampler constructs");
    let input: Vec<f32> = (0..INPUT_FRAMES_48K)
        .map(|i| (i as f32 * 0.01).sin())
        .collect();
    let expected_len = INPUT_FRAMES_48K as f64 * 16_000.0 / 48_000.0;

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
fn identity_resampler_returns_input_unchanged() {
    // Arrange
    let mut resampler = Resampler::new(16_000, 16_000).expect("resampler constructs");
    let input: Vec<f32> = vec![0.1, -0.2, 0.3, -0.4, 0.5];

    // Act
    let output = resampler.process(&input);
    let flushed = resampler.flush();

    // Assert
    assert_eq!(output, input);
    assert!(flushed.is_empty());
}

#[test]
fn downmix_to_mono_averages_stereo_channels() {
    // Arrange
    let stereo: Vec<f32> = vec![1.0, 0.0, 0.5, -0.5, -1.0, 1.0];

    // Act
    let mono = downmix_to_mono(&stereo, 2);

    // Assert
    assert_eq!(mono, vec![0.5, 0.0, 0.0]);
}

#[test]
fn new_adjustable_resampler_accepts_ratio_adjustment_even_at_equal_rates() {
    // Arrange
    let mut resampler =
        Resampler::new_adjustable(16_000, 16_000, 1.1).expect("adjustable resampler constructs");

    // Act
    let result = resampler.set_ratio_relative(0.005);

    // Assert
    assert!(result.is_ok());
}

#[test]
fn set_ratio_relative_is_a_no_op_on_the_identity_resampler() {
    // Arrange
    let mut resampler = Resampler::new(16_000, 16_000).expect("resampler constructs");

    // Act
    let result = resampler.set_ratio_relative(0.005);

    // Assert
    assert!(result.is_ok());
}

#[test]
fn downmix_to_mono_returns_input_unchanged_when_already_mono() {
    // Arrange
    let mono_input: Vec<f32> = vec![0.1, 0.2, 0.3];

    // Act
    let result = downmix_to_mono(&mono_input, 1);

    // Assert
    assert_eq!(result, mono_input);
}
