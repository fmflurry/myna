//! Regression coverage for a HIGH-severity bug: a panic mid-guarded-body
//! used to leave `AppState`'s import/summarization busy flags stuck
//! forever.
//!
//! Before this seam existed, every import-family command body
//! (`import_audio_blocking`, `retranscribe_meeting_blocking`,
//! `diarize_meeting_blocking`) and `commands::summary`'s equivalent followed
//! the shape:
//! ```ignore
//! state.begin_import()?;
//! let result = run_import(app, &state, path, title);
//! state.end_import();
//! result
//! ```
//! `state.end_import()` only runs if `run_import` *returns*. If it panics —
//! plausible for STT/FFI code decoding a malformed or adversarial WAV, and
//! this repo already wraps its CoreAudio callback in `catch_unwind` for
//! exactly this class of failure — the unwind skips `state.end_import()`
//! entirely. `spawn_blocking`'s `JoinError` is caught by the outer
//! `.await.unwrap_or_else(...)` and mapped to an `AppError`, but
//! `import_busy`/`summary_busy` are plain `AtomicBool`s unaffected by
//! unwinding, so they stayed `true` forever, wedging every later
//! `import_audio`/`retranscribe_meeting`/`diarize_meeting`/
//! `summarize_meeting`, *and* `start_recording` (gated by `import_busy` via
//! `guard_start`) until the process restarts.
//!
//! The fix is a **local RAII guard held across the whole blocking
//! wrapper**, coexisting with the existing `begin_import`/`end_import` and
//! `begin_summarization`/`end_summarization` pairs (which two other tests —
//! `tests/state.rs::begin_import_refuses_a_second_concurrent_import` and
//! `tests/concurrency.rs::concurrent_summarizations_yield_busy_for_all_but_one`
//! — depend on keeping their exact current signatures, so this file does
//! not touch them):
//! - `AppState::import_guard(&self) -> Result<ImportGuard<'_>, AppError>`,
//!   whose returned guard's `Drop` calls `state.end_import()`.
//! - `AppState::summarization_guard(&self) -> Result<SummarizationGuard<'_>, AppError>`,
//!   the same shape for `end_summarization()`.
//!
//! It is kept in its own file, separate from `tests/concurrency.rs`, so a
//! future regression in this guard's `Drop` behaviour cannot collaterally
//! block that file's unrelated, already-passing tests (a single
//! `tests/*.rs` file is one compiled binary; a compile error in one file
//! cannot affect another file's binary).
//!
//! `import_audio_blocking`/`retranscribe_meeting_blocking`/
//! `diarize_meeting_blocking` and the summarization command body now bind
//! `let _guard = state.import_guard()?;` (or `summarization_guard`) instead
//! of the standalone `begin_import()?`/`end_import()` pair, so a panic
//! during the guarded work unwinds through the guard's `Drop` and releases
//! the flag. These two tests prove exactly that.

use std::panic::{self, AssertUnwindSafe};

use myna_app::session::guard_start;
use myna_app::state::AppState;
use myna_app::store::folder_store::FsFolderStore;
use myna_app::store::fs_store::FsMeetingStore;

/// Proves `AppState::import_guard`'s `Drop` releases `import_busy` even when
/// the code running while the guard is held panics.
#[test]
fn import_guard_releases_the_busy_flag_even_when_the_guarded_body_panics() {
    // Arrange: a fresh, idle `AppState`.
    let dir = tempfile::tempdir().expect("tempdir");
    let state = AppState::new(
        FsMeetingStore::new(dir.path()),
        FsFolderStore::new(dir.path().to_path_buf()),
    );

    // Act: acquire the guard, then panic while it is alive — mirroring
    // `import_audio_blocking` binding `let _guard = state.import_guard()?;`
    // and then `run_import` panicking mid-body (e.g. malformed WAV in
    // STT/FFI decode). `catch_unwind` stands in for `spawn_blocking`'s own
    // panic capture, so the simulated panic doesn't abort this test
    // process.
    let panic_result = panic::catch_unwind(AssertUnwindSafe(|| {
        let _guard = state
            .import_guard()
            .expect("import_guard should succeed when idle");
        panic!("simulated panic mid-import, e.g. a malformed WAV in STT/FFI decode");
    }));
    assert!(
        panic_result.is_err(),
        "the simulated panic must actually unwind for this test to be meaningful"
    );

    // Assert: the busy flag must be released regardless of the panic — a
    // subsequent import must be allowed to start, and `start_recording`'s
    // `guard_start` must not see it as busy either. These two checks alone
    // are the actual contract under test (the flag was released); they are
    // deliberately NOT followed by a `begin_import()` re-acquisition, since
    // `begin_import`'s success path sets `import_busy` back to `true` (the
    // exact contract `tests/state.rs::begin_import_refuses_a_second_concurrent_import`
    // depends on) — asserting both "flag released" (`guard_start` sees it
    // as free) *and* "a subsequent begin_import() succeeds" in that order
    // would be self-contradictory, since the re-acquisition itself flips
    // the flag back to busy before any check that reads it afterward.
    assert!(
        !state.import_busy(),
        "import_busy must be false after a panic while import_guard was held; the guard's \
         Drop impl must call state.end_import() during unwind"
    );
    assert!(
        guard_start(false, state.import_busy()).is_ok(),
        "start_recording's guard_start must not report Busy once the import guard is released"
    );
}

/// Equivalent to
/// [`import_guard_releases_the_busy_flag_even_when_the_guarded_body_panics`]
/// for `AppState::summarization_guard`/`summary_busy`, which has the
/// identical shape and — since `commands::summary`'s command body follows
/// the same `begin_summarization()?; <work>; end_summarization();` pattern
/// — the identical stuck-flag risk.
#[test]
fn summarization_guard_releases_the_busy_flag_even_when_the_guarded_body_panics() {
    // Arrange: a fresh, idle `AppState`.
    let dir = tempfile::tempdir().expect("tempdir");
    let state = AppState::new(
        FsMeetingStore::new(dir.path()),
        FsFolderStore::new(dir.path().to_path_buf()),
    );

    // Act: acquire the guard, then panic while it is alive.
    let panic_result = panic::catch_unwind(AssertUnwindSafe(|| {
        let _guard = state
            .summarization_guard()
            .expect("summarization_guard should succeed when idle");
        panic!("simulated panic mid-summarization");
    }));
    assert!(
        panic_result.is_err(),
        "the simulated panic must actually unwind for this test to be meaningful"
    );

    // Assert: the busy flag must be released regardless of the panic — a
    // subsequent summarization must be allowed to start. `AppState` exposes
    // no public getter for the private `summary_busy` field (unlike
    // `import_busy()`), so `begin_summarization()` succeeding is itself the
    // observable proof the flag was released: it fails with `Busy` whenever
    // the flag is still `true`.
    assert!(
        state.begin_summarization().is_ok(),
        "a subsequent begin_summarization() must succeed once summarization_guard's Drop has \
         released the flag"
    );
}
