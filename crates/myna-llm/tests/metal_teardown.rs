//! Model-gated regression coverage for the ⌘Q Metal-teardown crash: ggml
//! unconditionally asserts every Metal buffer is freed before its device
//! is destroyed (`ggml-metal-device.m:656`). Myna now caches models in an
//! evictable `ModelSlot` (`app/src-tauri/src/state.rs`) and drops the
//! [`Summarizer`] at the end of every summarization (STT after an idle
//! TTL), so its weight buffers are normally freed long before quit — but
//! a crash, or an `Arc` still held when `exit()`'s static-destructor pass
//! runs, leaves them registered and the assert fires. The residency
//! workaround (`GGML_METAL_NO_RESIDENCY=1`) is the exit-safety guarantee
//! for both teardown paths below; see `myna_llm::init_ggml_env`'s docs
//! for the full chain and the fix.
//!
//! A crash at process exit can't be observed as a normal `#[test]`
//! failure (the test binary itself is the process that aborts), so both
//! cases here re-exec the test binary as a child process and assert on
//! its exit status instead.
//!
//! Both tests are `#[ignore]`d — like `tests/engine.rs` — so the default
//! `cargo test` run never touches the real model; run explicitly via
//! `cargo test -p myna-llm --release --locked --test metal_teardown -- --ignored --test-threads=1`.

use std::path::Path;

use myna_llm::Summarizer;

/// Set (to any value) only in the re-exec'd child process, so the child
/// branch below never runs when this file is executed normally.
const CHILD: &str = "MYNA_METAL_TEARDOWN_CHILD";

/// Resolves the repo-root Qwen GGUF path from this crate's manifest dir
/// (`crates/myna-llm` -> repo root -> `models`), matching the convention
/// used by `tests/engine.rs` and `tests/language.rs`.
fn qwen_model_path() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../models/qwen2.5-3b-instruct/qwen2.5-3b-instruct-q4_k_m.gguf")
}

/// Re-execs the current test binary to run `test_name` alone, as the
/// child process the `CHILD` env var identifies, and returns its exit
/// status. Shared by both tests below; only the test name differs.
fn run_as_child(test_name: &str) -> std::process::ExitStatus {
    std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "--ignored", "--test-threads=1", test_name])
        .env(CHILD, "1")
        .status()
        .expect("spawn child")
}

#[test]
#[ignore = "model-gated: requires models/qwen2.5-3b-instruct/*.gguf on disk"]
fn a_leaked_summarizer_does_not_abort_the_process_at_exit() {
    if std::env::var_os(CHILD).is_some() {
        // Child: mirror AppState's evictable ModelSlot cache — load and never
        // drop, then let libtest's own process exit run ggml's static destructors.
        let summarizer = Summarizer::load(&qwen_model_path()).expect("model load");
        std::mem::forget(summarizer);
        return;
    }

    // Parent: the child aborting (SIGABRT, status code 6) is exactly the
    // bug this test guards against — a clean exit is the fix working.
    let status = run_as_child("a_leaked_summarizer_does_not_abort_the_process_at_exit");
    assert!(
        status.success(),
        "child aborted during static teardown (ggml_metal_rsets_free): {status:?}"
    );
}

#[test]
#[ignore = "model-gated: requires models/qwen2.5-3b-instruct/*.gguf on disk"]
fn a_normally_dropped_summarizer_still_exits_cleanly() {
    if std::env::var_os(CHILD).is_some() {
        // Child: load and drop normally (the non-leaking half of the
        // contract) — documents that a live-then-freed Metal buffer also
        // tears down cleanly, guarding against a future regression where
        // a buffer stops being freed at all.
        let summarizer = Summarizer::load(&qwen_model_path()).expect("model load");
        drop(summarizer);
        return;
    }

    let status = run_as_child("a_normally_dropped_summarizer_still_exits_cleanly");
    assert!(
        status.success(),
        "child aborted during static teardown after a normal drop: {status:?}"
    );
}
