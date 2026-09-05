//! Tests for [`myna_app::state`]: the STT engine thread-count derivation
//! (pure logic over an `Option<i32>`, so no Tauri app handle or model load
//! is needed), the import/re-transcribe busy-guard
//! (`begin_import`/`end_import`/`cancel_import`), which only touch
//! in-memory atomics and a tempdir-backed store — mirrors
//! `tests/concurrency.rs`'s summarization busy-guard tests — and the
//! Phase-3 `ModelSlot` eviction protocol that replaced the never-cleared
//! `OnceLock` model caches.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Weak};
use std::time::Duration;

use myna_app::state::{
    clamp_thread_count, AppState, ModelSlot, STT_ENGINE_THREADS_FALLBACK, STT_ENGINE_THREADS_MAX,
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

// --- ModelSlot: evictable model caches (Phase 3 of the memory-leak fix) ---
//
// The pre-Phase-3 `AppState` held each model in a `OnceLock` that was
// never cleared, so every loaded model's RAM (~5 GB for Qwen, ~1 GB for
// Parakeet, plus the diarizer pair) leaked for the whole app lifetime.
// `ModelSlot` replaces those caches with evictable slots; the `Weak`
// handles below are the proof that a "release" actually DROPS the model
// rather than just forgetting where it lives. Against the old `OnceLock`
// API these assertions cannot even be expressed — which is exactly the
// "never released" bug this phase fixes.

/// Stand-in for a loaded model: the slot mechanism is type-agnostic, and
/// a real `Summarizer`/`SttEngine`/`Diarizer` needs the multi-GB GGUF /
/// ONNX artifacts on disk (exercised separately by the `#[ignore]`d
/// model-gated tests below).
#[derive(Debug)]
struct FakeModel;

fn fresh_state(dir: &Path) -> AppState {
    AppState::new(
        FsMeetingStore::new(dir),
        FsFolderStore::new(dir.to_path_buf()),
    )
}

#[test]
fn models_are_released_after_operations() {
    // Arrange: a slot in the state a command would hold, acquired the same
    // way `run_summarization`/`run_diarize` acquire theirs.
    let slot: ModelSlot<FakeModel> = ModelSlot::new();
    let operation_arc = slot
        .get_or_load(|| Ok(Arc::new(FakeModel)))
        .expect("fake model load");
    let weak: Weak<FakeModel> = slot.weak().expect("slot holds the model after acquire");
    assert!(weak.upgrade().is_some());
    assert_eq!(
        slot.arc_count(),
        Some(2),
        "slot + the in-flight operation each hold one reference"
    );

    // Act/Assert 1: an end-of-op release while the operation still holds
    // its Arc must NOT drop the model.
    assert!(
        !slot.release_if_last(),
        "release must be refused while a live operation reference exists"
    );
    assert!(
        weak.upgrade().is_some(),
        "model must survive a refused release"
    );

    // Act/Assert 2: the operation completes — drop the local Arc, then
    // release the slot (exactly the `run_summarization` tail protocol).
    drop(operation_arc);
    assert!(
        slot.release_if_last(),
        "release must clear the slot once the slot is the sole holder"
    );
    assert!(
        weak.upgrade().is_none(),
        "end-of-operation release must actually DROP the model — the OnceLock \
         cache this replaces could never, which is the leak being fixed"
    );
    assert_eq!(
        slot.arc_count(),
        None,
        "released slot reports no cached model"
    );
}

#[test]
fn get_or_load_reuses_the_cached_model_until_release() {
    let slot: ModelSlot<FakeModel> = ModelSlot::new();
    let first = slot.get_or_load(|| Ok(Arc::new(FakeModel))).expect("load");
    let second = slot
        .get_or_load(|| panic!("second acquire must hit the cache, not the loader"))
        .expect("cached clone");
    assert!(
        Arc::ptr_eq(&first, &second),
        "both acquires share one model"
    );
    assert_eq!(slot.arc_count(), Some(3)); // slot + first + second
    drop(first);
    drop(second);
    assert!(slot.release_if_last());
}

#[test]
fn failed_load_leaves_the_slot_empty_and_retryable() {
    // The old OnceLock accessors documented "a failed load must not poison
    // the cache" as a caller obligation; the slot enforces it.
    let slot: ModelSlot<FakeModel> = ModelSlot::new();
    let err = slot
        .get_or_load(|| {
            Err(myna_app::error::AppError::Store(
                "simulated load failure".into(),
            ))
        })
        .expect_err("load failure must surface");
    assert!(err.to_string().contains("simulated load failure"));
    assert!(
        slot.weak().is_none(),
        "failed load must not populate the slot"
    );
    slot.get_or_load(|| Ok(Arc::new(FakeModel)))
        .expect("a later load must still succeed after a failed one");
}

#[test]
fn stt_slot_evicted_only_after_ttl_and_when_nothing_holds_it() {
    let slot: ModelSlot<FakeModel> = ModelSlot::new();
    let arc = slot.get_or_load(|| Ok(Arc::new(FakeModel))).expect("load");
    let weak = slot.weak().expect("populated");

    // TTL not elapsed (1 h from a just-touched slot): not evicted.
    assert!(!slot.evict_if_idle(Duration::from_secs(3600)));
    assert!(weak.upgrade().is_some());

    // TTL elapsed but the session/operation still holds the Arc: never
    // evicted — this is the "session Some → never evicted" guarantee,
    // enforced structurally by the strong-count check (a live
    // `RecordingSession` holds exactly such a clone).
    assert!(
        !slot.evict_if_idle(Duration::ZERO),
        "eviction must refuse while a live reference exists"
    );
    assert!(weak.upgrade().is_some());

    // Session slot None (reference dropped) + TTL elapsed: evicted.
    drop(arc);
    assert!(slot.evict_if_idle(Duration::ZERO));
    assert!(weak.upgrade().is_none());
}

#[test]
fn stt_evict_guard_refuses_while_recording_or_importing() {
    // The pure decision behind `AppState::evict_stt_if_idle`, mirroring the
    // `guard_start` precedent: a real `RecordingSession` cannot be
    // constructed in a unit test (device + model needed).
    assert!(
        !myna_app::state::stt_evict_allowed(true, false),
        "session Some → never evicted"
    );
    assert!(
        !myna_app::state::stt_evict_allowed(false, true),
        "import/re-transcribe in flight → never evicted"
    );
    assert!(
        myna_app::state::stt_evict_allowed(false, false),
        "idle app → eviction allowed (subject to the TTL)"
    );
}

#[test]
fn app_state_release_and_evict_are_safe_on_fresh_state() {
    let dir = tempfile::tempdir().expect("tempdir");
    let state = fresh_state(dir.path());
    // Nothing loaded yet: every release/evict path must be a no-op, not a
    // panic, and the slots must start empty.
    assert_eq!(state.summarizer_slot().arc_count(), None);
    assert_eq!(state.diarizer_slot().arc_count(), None);
    assert_eq!(state.stt_slot().arc_count(), None);
    assert!(!state.release_summarizer());
    assert!(!state.release_diarizer());
    assert!(!state.evict_stt_if_idle());

    // A contended session lock (a start/stop in flight) must also refuse
    // eviction rather than block or evict under the recording.
    let session_guard = state.session.lock().expect("session lock");
    assert!(!state.evict_stt_if_idle());
    drop(session_guard);

    // An import in flight likewise refuses.
    state.begin_import().expect("begin_import");
    assert!(!state.evict_stt_if_idle());
}

// --- model-gated: real Summarizer reload + RSS release ---------------------
//
// Same conventions as `crates/myna-llm/tests/metal_teardown.rs`: `#[ignore]`
// + re-exec'd child process, model resolved from the repo-root `models/`.

/// Set (to any value) only in the re-exec'd child, so the child branch
/// below never runs when this file is executed normally.
const RSS_CHILD: &str = "MYNA_RSS_RELEASE_CHILD";

fn qwen_model_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../models/qwen2.5-7b-instruct/qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf")
}

/// Current process RSS in MB, via `ps` (no sysinfo dev-dependency needed
/// in this crate; macOS `ps` reports KB).
fn rss_mb(pid: u32) -> u64 {
    let output = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .expect("spawn ps");
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<u64>()
        .expect("ps rss output")
        / 1024
}

#[test]
#[ignore = "model-gated: requires models/qwen2.5-7b-instruct/qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf on disk"]
fn summarizer_reloads_after_being_dropped() {
    // CRITICAL precondition for end-of-operation release: a second
    // `Summarizer::load` in the same process must succeed after the first
    // was dropped (llama-cpp-2 0.1.154's `LlamaBackend::drop` resets the
    // once-per-process init flag and calls `llama_backend_free`).
    let path = qwen_model_path();
    if !path.is_file() {
        eprintln!("skipping: {} not present", path.display());
        return;
    }
    let first = myna_llm::Summarizer::load(&path).expect("first load");
    drop(first);
    let second = myna_llm::Summarizer::load(&path).expect("reload after drop must succeed");
    drop(second);
}

#[test]
#[ignore = "model-gated: requires models/qwen2.5-7b-instruct/qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf on disk"]
fn dropping_the_summarizer_returns_rss_to_the_os() {
    let path = qwen_model_path();
    if !path.is_file() {
        eprintln!("skipping: {} not present", path.display());
        return;
    }

    if std::env::var_os(RSS_CHILD).is_some() {
        // Child: sample RSS around a load+drop cycle and print it for the
        // parent to assert on. `Summarizer::drop` joins the inference
        // worker, which frees weights + KV cache synchronously.
        let base = rss_mb(std::process::id());
        let summarizer = myna_llm::Summarizer::load(&path).expect("model load");
        let loaded = rss_mb(std::process::id());
        drop(summarizer);
        std::thread::sleep(Duration::from_millis(500));
        let freed = rss_mb(std::process::id());
        println!("MYNA_RSS base={base} loaded={loaded} after_drop={freed}");
        return;
    }

    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "--ignored",
            "--test-threads=1",
            "--nocapture",
            "dropping_the_summarizer_returns_rss_to_the_os",
        ])
        .env(RSS_CHILD, "1")
        .output()
        .expect("spawn child");
    let stdout = String::from_utf8_lossy(&output.stdout);
    // With `--nocapture` the child's println interleaves onto the same
    // line as libtest's `test <name> ...` prefix, so locate the marker
    // anywhere in the output and read to end-of-line from there.
    let sample = stdout
        .lines()
        .find_map(|line| line.rfind("MYNA_RSS ").map(|i| &line[i..]))
        .unwrap_or_else(|| panic!("child printed no MYNA_RSS line:\n{stdout}"));
    let value = |key: &str| -> u64 {
        sample
            .split_whitespace()
            .find_map(|token| token.strip_prefix(&format!("{key}=")))
            .and_then(|v| v.parse().ok())
            .unwrap_or_else(|| panic!("missing {key} in: {sample}"))
    };
    let (base, loaded, after_drop) = (value("base"), value("loaded"), value("after_drop"));
    assert!(
        loaded > base + 800,
        "loading Qwen should grow RSS by >800 MB (base={base} MB, loaded={loaded} MB)"
    );
    assert!(
        loaded - after_drop >= 800,
        "dropping the Summarizer should return >=800 MB to the OS \
         (loaded={loaded} MB, after_drop={after_drop} MB, freed={} MB)",
        loaded - after_drop
    );
}
