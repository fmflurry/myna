//! Tests for [`myna_app::state`]: the STT engine thread-count derivation
//! (pure logic over an `Option<i32>`, so no Tauri app handle or model load
//! is needed) and the import/re-transcribe busy-guard
//! (`begin_import`/`end_import`/`cancel_import`), which only touch
//! in-memory atomics and a tempdir-backed store — mirrors
//! `tests/concurrency.rs`'s summarization busy-guard tests.

use std::sync::atomic::Ordering;

use myna_app::state::{
    clamp_thread_count, AppState, STT_ENGINE_THREADS_FALLBACK, STT_ENGINE_THREADS_MAX,
    STT_ENGINE_THREADS_MIN,
};
use myna_app::store::folder_store::FsFolderStore;
use myna_app::store::fs_store::FsMeetingStore;

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

// --- begin_import / end_import -----------------------------------------

#[test]
fn begin_import_succeeds_when_idle() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let state = AppState::new(
        FsMeetingStore::new(dir.path()),
        FsFolderStore::new(dir.path().to_path_buf()),
    );

    // Act / Assert
    assert!(state.begin_import().is_ok());
}

#[test]
fn begin_import_refuses_a_second_concurrent_import() {
    // Arrange: one import already in flight.
    let dir = tempfile::tempdir().expect("tempdir");
    let state = AppState::new(
        FsMeetingStore::new(dir.path()),
        FsFolderStore::new(dir.path().to_path_buf()),
    );
    state
        .begin_import()
        .expect("first begin_import should succeed when idle");

    // Act
    let err = state
        .begin_import()
        .expect_err("a second concurrent import must be refused");

    // Assert: variant is Busy, and the message names the import conflict.
    assert!(matches!(err, myna_app::error::AppError::Busy(_)));
    assert!(err.to_string().to_lowercase().contains("import"));
}

#[test]
fn end_import_allows_a_new_import_to_begin_afterwards() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let state = AppState::new(
        FsMeetingStore::new(dir.path()),
        FsFolderStore::new(dir.path().to_path_buf()),
    );
    state.begin_import().expect("first begin_import");

    // Act
    state.end_import();

    // Assert
    assert!(
        state.begin_import().is_ok(),
        "begin_import must succeed again once end_import released the flag"
    );
}

#[test]
fn begin_import_resets_a_stale_cancel_flag_from_a_prior_run() {
    // Arrange: a prior run left the cancellation flag set (e.g. it was
    // cancelled and then finished).
    let dir = tempfile::tempdir().expect("tempdir");
    let state = AppState::new(
        FsMeetingStore::new(dir.path()),
        FsFolderStore::new(dir.path().to_path_buf()),
    );
    state.cancel_import.store(true, Ordering::SeqCst);

    // Act
    state
        .begin_import()
        .expect("begin_import should succeed when idle");

    // Assert: the new run must not be born already cancelled.
    assert!(!state.cancel_import.load(Ordering::SeqCst));
}

// --- cancel_import -------------------------------------------------------

/// `cancel_import` (the `#[tauri::command]`) is a single
/// `state.cancel_import.store(true, Ordering::SeqCst)` — mirrors
/// `tests/concurrency.rs`'s treatment of `cancel_summarization`, which
/// exercises the same underlying flag directly rather than constructing a
/// `tauri::State` (which needs a real app).
#[test]
fn cancel_import_sets_the_shared_cancellation_flag() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let state = AppState::new(
        FsMeetingStore::new(dir.path()),
        FsFolderStore::new(dir.path().to_path_buf()),
    );
    state.begin_import().expect("begin_import");
    assert!(!state.cancel_import.load(Ordering::SeqCst));

    // Act: what `cancel_import` does.
    state.cancel_import.store(true, Ordering::SeqCst);

    // Assert
    assert!(
        state.cancel_import.load(Ordering::SeqCst),
        "cancel_import must set the shared flag observed by the running import"
    );
}
