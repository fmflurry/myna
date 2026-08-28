//! RMS level metering.

/// Floor applied to [`rms_dbfs`] so silence reports a finite value instead of
/// `-inf`.
pub const SILENCE_FLOOR_DBFS: f32 = -100.0;

/// Root-mean-square amplitude of `samples`, in the same units as the samples
/// themselves (i.e. full-scale is `1.0`).
///
/// Returns `0.0` for an empty slice.
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }

    let sum_of_squares: f32 = samples.iter().map(|sample| sample * sample).sum();
    (sum_of_squares / samples.len() as f32).sqrt()
}

/// RMS level of `samples` in dBFS (decibels relative to full scale),
/// clamped at [`SILENCE_FLOOR_DBFS`].
pub fn rms_dbfs(samples: &[f32]) -> f32 {
    let level = rms(samples);
    if level <= 0.0 {
        return SILENCE_FLOOR_DBFS;
    }

    let dbfs = 20.0 * level.log10();
    dbfs.max(SILENCE_FLOOR_DBFS)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tolerance used when comparing floating-point RMS results.
    const EPSILON: f32 = 1e-3;

    /// Number of samples used for the sine-wave fixture; large enough to
    /// average over many full cycles.
    const SINE_SAMPLE_COUNT: usize = 10_000;

    fn sine_wave(amplitude: f32, sample_count: usize) -> Vec<f32> {
        (0..sample_count)
            .map(|i| amplitude * (i as f32 * 0.1).sin())
            .collect()
    }

    #[test]
    fn rms_of_silence_is_zero() {
        // Arrange
        let silence = vec![0.0f32; 1_000];

        // Act
        let level = rms(&silence);

        // Assert
        assert!((level - 0.0).abs() < EPSILON);
    }

    #[test]
    fn rms_of_half_amplitude_sine_is_approximately_0_354() {
        // Arrange
        let sine = sine_wave(0.5, SINE_SAMPLE_COUNT);

        // Act
        let level = rms(&sine);

        // Assert
        assert!(
            (level - 0.354).abs() < EPSILON,
            "expected rms ~= 0.354, got {level}"
        );
    }

    #[test]
    fn rms_dbfs_of_silence_equals_the_floor() {
        // Arrange
        let silence = vec![0.0f32; 1_000];

        // Act
        let dbfs = rms_dbfs(&silence);

        // Assert
        assert_eq!(dbfs, SILENCE_FLOOR_DBFS);
    }
}
