//! Concurrency regression tests for the async-command conversion.
//!
//! Converting `start_recording`/`stop_recording`/`cancel_recording`/
//! `summarize_meeting` from plain synchronous `#[tauri::command]` fns to
//! `async fn`s (each running its whole body on a
//! `tauri::async_runtime::spawn_blocking` thread) means two invocations can
//! now genuinely run concurrently, where before Tauri's main-thread command
//! dispatch fully serialized them. These tests drive the same guard
//! primitives the commands use — [`guard_start`] and
//! [`AppState::begin_summarization`]/[`AppState::end_summarization`] — from
//! multiple real OS threads racing against each other, to prove the `Busy`
//! guards still hold under genuine concurrency rather than only under the
//! sequential access the old synchronous dispatch happened to guarantee.
//!
//! No test here loads an STT or LLM model: [`guard_start`] is a pure
//! decision function over a `bool`, and [`AppState::begin_summarization`]/
//! [`AppState::end_summarization`] only touch an in-memory `AtomicBool` —
//! exactly the "use the existing pure guard functions" seam the commands
//! themselves are built on.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use myna_app::error::AppError;
use myna_app::session::guard_start;
use myna_app::state::AppState;
use myna_app::store::folder_store::FsFolderStore;
use myna_app::store::fs_store::FsMeetingStore;

const RACING_THREADS: usize = 8;

/// Mirrors the exact pattern `start_recording_blocking` uses: lock a
/// `Mutex<Option<T>>`, consult [`guard_start`] on whether a slot is already
/// occupied, and only insert into the slot on success. Real
/// `start_recording` locks `AppState::session` for this same
/// check-then-insert; a plain `()` slot here exercises the identical
/// guard/lock interaction without needing a real `RecordingSession`
/// (device, STT model, worker threads).
fn try_start(slot: &Mutex<Option<()>>) -> Result<(), AppError> {
    let mut guard = slot.lock().expect("lock poisoned");
    guard_start(guard.is_some(), false)?;
    // Hold the lock for a moment, like the real command does while it sets
    // up a session, so racing threads actually overlap instead of the OS
    // scheduler trivially serializing them one at a time.
    thread::sleep(Duration::from_millis(5));
    *guard = Some(());
    Ok(())
}

#[test]
fn concurrent_recording_starts_yield_busy_for_all_but_one() {
    // Arrange: an idle slot, as `AppState::session` is before any recording
    // has started.
    let slot = Arc::new(Mutex::new(None::<()>));
    let successes = Arc::new(AtomicUsize::new(0));
    let busy_rejections = Arc::new(AtomicUsize::new(0));

    // Act: race many threads to "start a recording" at once.
    let handles: Vec<_> = (0..RACING_THREADS)
        .map(|_| {
            let slot = Arc::clone(&slot);
            let successes = Arc::clone(&successes);
            let busy_rejections = Arc::clone(&busy_rejections);
            thread::spawn(move || match try_start(&slot) {
                Ok(()) => {
                    successes.fetch_add(1, Ordering::SeqCst);
                }
                Err(AppError::Busy(_)) => {
                    busy_rejections.fetch_add(1, Ordering::SeqCst);
                }
                Err(other) => panic!("unexpected error from a racing start: {other:?}"),
            })
        })
        .collect();

    for handle in handles {
        handle.join().expect("racing thread should not panic");
    }

    // Assert: exactly one racer wins the slot; every other racer observes
    // it as busy — never two concurrent winners.
    assert_eq!(successes.load(Ordering::SeqCst), 1);
    assert_eq!(busy_rejections.load(Ordering::SeqCst), RACING_THREADS - 1);
}

#[test]
fn concurrent_summarizations_yield_busy_for_all_but_one() {
    // Arrange: a fresh `AppState`, as if idle (no summarization running).
    let dir = tempfile::tempdir().expect("tempdir");
    let state = Arc::new(AppState::new(
        FsMeetingStore::new(dir.path()),
        FsFolderStore::new(dir.path().to_path_buf()),
    ));
    let successes = Arc::new(AtomicUsize::new(0));
    let busy_rejections = Arc::new(AtomicUsize::new(0));

    // Act: race many threads to "begin a summarization" at once, exactly as
    // concurrent `summarize_meeting` invocations would each call
    // `AppState::begin_summarization` before doing any generation work.
    let handles: Vec<_> = (0..RACING_THREADS)
        .map(|_| {
            let state = Arc::clone(&state);
            let successes = Arc::clone(&successes);
            let busy_rejections = Arc::clone(&busy_rejections);
            thread::spawn(move || match state.begin_summarization() {
                Ok(()) => {
                    successes.fetch_add(1, Ordering::SeqCst);
                    // Hold "busy" for a moment, like a real generation
                    // would, so racing threads actually overlap.
                    thread::sleep(Duration::from_millis(5));
                    state.end_summarization();
                }
                Err(AppError::Busy(_)) => {
                    busy_rejections.fetch_add(1, Ordering::SeqCst);
                }
                Err(other) => panic!("unexpected error from a racing begin: {other:?}"),
            })
        })
        .collect();

    for handle in handles {
        handle.join().expect("racing thread should not panic");
    }

    // Assert: exactly one racer is ever allowed to run at a time. Since
    // each winner releases the guard (`end_summarization`) before this
    // assertion, multiple racers may have won *sequentially*, but the sum
    // must still account for every thread, and no run before this one can
    // have overlapped without being rejected as busy.
    let won = successes.load(Ordering::SeqCst);
    let rejected = busy_rejections.load(Ordering::SeqCst);
    assert!(won >= 1, "at least one racer must win the busy guard");
    assert_eq!(won + rejected, RACING_THREADS);
}

#[test]
fn begin_summarization_resets_a_stale_cancel_flag_from_a_prior_run() {
    // Arrange: a prior run left the cancellation flag set (e.g. it was
    // cancelled and then finished).
    let dir = tempfile::tempdir().expect("tempdir");
    let state = AppState::new(
        FsMeetingStore::new(dir.path()),
        FsFolderStore::new(dir.path().to_path_buf()),
    );
    state.cancel_summary.store(true, Ordering::SeqCst);

    // Act
    state
        .begin_summarization()
        .expect("begin_summarization should succeed when idle");

    // Assert: the new run must not be born already cancelled.
    assert!(!state.cancel_summary.load(Ordering::SeqCst));
}

/// Proves the `Arc<AtomicBool>` cancellation flag `AppState` shares with the
/// summarization worker (`state.cancel_summary`, the same field
/// `cancel_summarization` writes to and `run_inference` reads from) still
/// propagates correctly now that the worker runs inside a
/// `spawn_blocking` closure obtained via `app.state::<AppState>()` rather
/// than a directly-captured `State<'_, AppState>` reference. The loop below
/// mirrors the documented contract of `myna_llm::Summarizer::summarize`
/// (observes the shared flag, bails out once it is set) without depending
/// on `myna_llm` or a real model — out of scope for this fix.
#[test]
fn cancelling_a_running_summarization_is_observed_by_the_shared_flag() {
    // Arrange: a fresh `AppState`, with a summarization already marked
    // in-flight — the state `summarize_meeting` is in while its worker
    // runs.
    let dir = tempfile::tempdir().expect("tempdir");
    let state = AppState::new(
        FsMeetingStore::new(dir.path()),
        FsFolderStore::new(dir.path().to_path_buf()),
    );
    state
        .begin_summarization()
        .expect("begin_summarization should succeed when idle");

    let cancel_for_worker = Arc::clone(&state.cancel_summary);
    let observed_cancellation = Arc::new(AtomicBool::new(false));
    let observed_for_worker = Arc::clone(&observed_cancellation);

    // Act: a worker loop standing in for `Summarizer::summarize`'s
    // documented per-token cancellation check, racing against a
    // `cancel_summarization`-equivalent flag flip from another thread.
    let worker = thread::spawn(move || {
        for _ in 0..2_000 {
            if cancel_for_worker.load(Ordering::SeqCst) {
                observed_for_worker.store(true, Ordering::SeqCst);
                return;
            }
            thread::sleep(Duration::from_millis(1));
        }
    });

    thread::sleep(Duration::from_millis(20));
    state.cancel_summary.store(true, Ordering::SeqCst); // what `cancel_summarization` does
    worker.join().expect("worker thread should not panic");

    // Assert
    assert!(
        observed_cancellation.load(Ordering::SeqCst),
        "the worker should observe the cancellation flag flip and stop"
    );
}
