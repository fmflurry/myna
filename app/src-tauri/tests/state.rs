//! Tests for the STT engine thread-count derivation in
//! [`myna_app::state`] — pure logic over an `Option<i32>`, so no Tauri
//! app handle or model load is needed.

use myna_app::state::{
    clamp_thread_count, STT_ENGINE_THREADS_FALLBACK, STT_ENGINE_THREADS_MAX, STT_ENGINE_THREADS_MIN,
};

#[test]
fn falls_back_when_parallelism_is_undetected() {
    assert_eq!(clamp_thread_count(None), STT_ENGINE_THREADS_FALLBACK);
}

#[test]
fn clamps_low_detected_counts_up_to_the_minimum() {
    assert_eq!(clamp_thread_count(Some(1)), STT_ENGINE_THREADS_MIN);
}

#[test]
fn clamps_high_detected_counts_down_to_the_maximum() {
    assert_eq!(clamp_thread_count(Some(64)), STT_ENGINE_THREADS_MAX);
}

#[test]
fn passes_through_detected_counts_within_range() {
    assert_eq!(clamp_thread_count(Some(4)), 4);
}
