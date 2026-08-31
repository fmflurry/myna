//! Tests for the system-audio ring buffer, drift controller, and mixer.
//! Everything here is deterministic: no real audio device, no platform API,
//! and no `sleep` — simulated time is injected as an `Instant` parameter.

use std::time::{Duration, Instant};

use myna_audio::{
    mix_into, DriftController, SampleRing, MAX_DRIFT_ADJUST, MIX_GAIN, SYSTEM_RING_CAPACITY,
    TARGET_FILL_SAMPLES,
};

/// Small ring capacity used by the overflow test, distinct from the real
/// [`SYSTEM_RING_CAPACITY`] so the front-drop behavior is easy to verify by
/// hand.
const TEST_RING_CAPACITY: usize = 10;

/// Small target-fill level paired with [`TEST_RING_CAPACITY`].
const TEST_TARGET_FILL: usize = 4;

/// Mic block size used by the drift-simulation test: 10 ms at 16 kHz.
const DRIFT_SIM_BLOCK_SAMPLES: usize = 160;

/// Simulated tick length used by the drift-simulation test.
const DRIFT_SIM_TICK_INTERVAL: Duration = Duration::from_millis(10);

/// Simulated clock drift applied to the system-audio source: 500 parts per
/// million faster than the mic's nominal rate.
const DRIFT_SIM_PPM: f64 = 500.0;

/// Total simulated duration of the drift test.
const DRIFT_SIM_SECONDS: u64 = 60;

#[test]
fn pop_into_zero_pads_on_underrun() {
    // Arrange
    let ring = SampleRing::new(SYSTEM_RING_CAPACITY, TARGET_FILL_SAMPLES);
    ring.push(&[1.0, 2.0, 3.0]);

    // Act
    let popped = ring.pop_into(5);

    // Assert
    assert_eq!(popped, vec![1.0, 2.0, 3.0, 0.0, 0.0]);
}

#[test]
fn pop_into_never_returns_fewer_samples_than_requested_from_an_empty_ring() {
    // Arrange
    let ring = SampleRing::new(SYSTEM_RING_CAPACITY, TARGET_FILL_SAMPLES);

    // Act
    let popped = ring.pop_into(8);

    // Assert
    assert_eq!(popped, vec![0.0; 8]);
}

#[test]
fn push_resyncs_to_target_fill_by_dropping_from_the_front_on_overflow() {
    // Arrange
    let ring = SampleRing::new(TEST_RING_CAPACITY, TEST_TARGET_FILL);
    let initial: Vec<f32> = (0..TEST_RING_CAPACITY).map(|i| i as f32).collect();
    ring.push(&initial); // fills the ring exactly to capacity, no overflow yet

    // Act: this push overflows (fill 10 + 3 > capacity 10), triggering a
    // resync down to TEST_TARGET_FILL before the new samples are appended.
    ring.push(&[10.0, 11.0, 12.0]);

    // Assert: the oldest 6 samples (0..6) were dropped from the front,
    // leaving [6, 7, 8, 9] plus the 3 newly pushed samples.
    assert_eq!(ring.resync_count(), 1);
    assert_eq!(ring.len(), TEST_TARGET_FILL + 3);
    let popped = ring.pop_into(TEST_TARGET_FILL + 3);
    assert_eq!(popped, vec![6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0]);
}

#[test]
fn clear_to_drops_from_the_front_and_counts_a_resync() {
    // Arrange
    let ring = SampleRing::new(TEST_RING_CAPACITY, TEST_TARGET_FILL);
    let initial: Vec<f32> = (0..6).map(|i| i as f32).collect();
    ring.push(&initial);

    // Act
    ring.clear_to(2);

    // Assert
    assert_eq!(ring.resync_count(), 1);
    assert_eq!(ring.pop_into(2), vec![4.0, 5.0]);
}

#[test]
fn drift_controller_reports_negative_adjustment_when_ring_is_over_full() {
    // Arrange
    let mut controller = DriftController::new(TARGET_FILL_SAMPLES);
    let now = Instant::now();

    // Act
    controller.observe(TARGET_FILL_SAMPLES * 2, now);

    // Assert
    assert!(controller.adjustment() < 0.0);
}

#[test]
fn drift_controller_reports_positive_adjustment_when_ring_is_under_full() {
    // Arrange
    let mut controller = DriftController::new(TARGET_FILL_SAMPLES);
    let now = Instant::now();

    // Act
    controller.observe(TARGET_FILL_SAMPLES / 2, now);

    // Assert
    assert!(controller.adjustment() > 0.0);
}

#[test]
fn drift_controller_clamps_adjustment_to_max_drift_adjust() {
    // Arrange
    let mut over_full = DriftController::new(TARGET_FILL_SAMPLES);
    let mut under_full = DriftController::new(TARGET_FILL_SAMPLES);
    let now = Instant::now();

    // Act
    over_full.observe(TARGET_FILL_SAMPLES * 100, now);
    under_full.observe(0, now);

    // Assert
    assert_eq!(over_full.adjustment(), -MAX_DRIFT_ADJUST);
    assert_eq!(under_full.adjustment(), MAX_DRIFT_ADJUST);
}

#[test]
fn drift_controller_only_recomputes_once_per_check_interval() {
    // Arrange
    let mut controller = DriftController::new(TARGET_FILL_SAMPLES);
    let start = Instant::now();
    controller.observe(TARGET_FILL_SAMPLES * 2, start);
    let first_adjustment = controller.adjustment();

    // Act: this observation arrives too soon and should be ignored.
    controller.observe(TARGET_FILL_SAMPLES / 2, start + Duration::from_millis(500));

    // Assert
    assert_eq!(controller.adjustment(), first_adjustment);

    // Act: a full interval has now elapsed, so this one recomputes.
    controller.observe(TARGET_FILL_SAMPLES / 2, start + Duration::from_secs(1));

    // Assert
    assert!(controller.adjustment() > 0.0);
}

#[test]
fn frozen_drift_controller_ignores_observations() {
    // Arrange
    let mut controller = DriftController::new(TARGET_FILL_SAMPLES);
    let start = Instant::now();
    controller.observe(TARGET_FILL_SAMPLES * 2, start);
    let frozen_adjustment = controller.adjustment();
    controller.freeze();

    // Act
    controller.observe(0, start + Duration::from_secs(5));

    // Assert
    assert!(controller.is_frozen());
    assert_eq!(controller.adjustment(), frozen_adjustment);

    // Act: unfreezing resumes normal recomputation.
    controller.unfreeze();
    controller.observe(0, start + Duration::from_secs(6));

    // Assert
    assert!(!controller.is_frozen());
    assert!(controller.adjustment() > 0.0);
}

#[test]
fn mix_into_never_exceeds_full_scale() {
    // Arrange
    let mic = vec![1.0f32; 4];
    let sys = vec![1.0f32; 4];
    let mut out = vec![0.0f32; 4];

    // Act
    mix_into(&mic, &sys, &mut out);

    // Assert
    assert!(out.iter().all(|&sample| (-1.0..=1.0).contains(&sample)));
    let expected = (MIX_GAIN + MIX_GAIN).clamp(-1.0, 1.0);
    assert!(out
        .iter()
        .all(|&sample| (sample - expected).abs() < f32::EPSILON));
}

#[test]
fn mix_into_clamps_negative_full_scale_sum() {
    // Arrange
    let mic = vec![-1.0f32; 4];
    let sys = vec![-1.0f32; 4];
    let mut out = vec![0.0f32; 4];

    // Act
    mix_into(&mic, &sys, &mut out);

    // Assert
    assert!(out.iter().all(|&sample| sample >= -1.0));
}

#[test]
#[should_panic(expected = "whole number of frames")]
fn clear_to_panics_in_debug_on_a_frame_misaligned_drop_for_a_stereo_ring() {
    // Arrange: an interleaved-stereo ring (frame_size 2) holding 4 frames.
    let ring = SampleRing::with_frame_size(8, 0, 2);
    ring.push(&[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);

    // Act: dropping down to 1 sample means dropping 7 — not a whole number
    // of 2-sample stereo frames, which would silently swap L/R for the one
    // sample left behind. Must panic in a debug build rather than do that.
    ring.clear_to(1);
}

#[test]
fn clear_to_accepts_a_frame_aligned_drop_for_a_stereo_ring() {
    // Arrange
    let ring = SampleRing::with_frame_size(8, 0, 2);
    ring.push(&[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);

    // Act: dropping to 2 samples (1 stereo frame) is frame-aligned.
    ring.clear_to(2);

    // Assert
    assert_eq!(ring.resync_count(), 1);
    assert_eq!(ring.pop_into(2), vec![0.7, 0.8]);
}

#[test]
fn drift_controller_keeps_ring_fill_bounded_under_500_ppm_drift_over_60_seconds() {
    // Arrange: prime the ring at the target fill so the assertion measures
    // steady-state drift correction, not startup transient.
    let ring = SampleRing::new(SYSTEM_RING_CAPACITY, TARGET_FILL_SAMPLES);
    ring.push(&vec![0.0f32; TARGET_FILL_SAMPLES]);
    let mut controller = DriftController::new(TARGET_FILL_SAMPLES);
    let drift_factor = 1.0 + DRIFT_SIM_PPM / 1_000_000.0;
    let start = Instant::now();
    let tick_count = (DRIFT_SIM_SECONDS * 1000) / DRIFT_SIM_TICK_INTERVAL.as_millis() as u64;

    // Act & Assert: each tick, the mic pulls one block (mic is the master
    // clock) and the drifting system source pushes a block whose size is
    // nudged by the controller's latest adjustment.
    for tick in 0..tick_count {
        let now = start + DRIFT_SIM_TICK_INTERVAL * tick as u32;
        ring.pop_into(DRIFT_SIM_BLOCK_SAMPLES);

        let push_count =
            ((DRIFT_SIM_BLOCK_SAMPLES as f64) * drift_factor * (1.0 + controller.adjustment()))
                .round() as usize;
        ring.push(&vec![0.0f32; push_count]);

        controller.observe(ring.len(), now);

        let deviation = (ring.len() as i64 - TARGET_FILL_SAMPLES as i64).abs();
        assert!(
            deviation <= (2 * TARGET_FILL_SAMPLES) as i64,
            "fill {} deviated from target {} by more than 2x at tick {tick}",
            ring.len(),
            TARGET_FILL_SAMPLES
        );
    }
}
