//! Model-gated end-to-end regression coverage for the `ggml_abort` crash
//! fixed by chunked prefill + map-reduce summarization: a long meeting
//! transcript used to make `Summarizer::summarize` submit its entire
//! prompt to `llama_decode` in one call, which aborts the whole process
//! once the prompt exceeds `n_batch` (2048 tokens by default — a 33-minute
//! meeting easily clears that). These tests build a transcript large
//! enough to have crashed the old code and assert the new code completes
//! instead.
//!
//! All tests here load the real Qwen model and are `#[ignore]`d so the
//! default `cargo test` run never touches it; run explicitly via
//! `cargo test -p myna-llm --release --locked -- --ignored`.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use myna_llm::{LlmError, RenderContext, Summarizer, SummaryOptions, Template};

/// A single realistic meeting-utterance line, repeated to build fixture
/// transcripts of a known-large approximate token count.
const FIXTURE_LINE: &str =
    "Alice: We reviewed the quarterly roadmap and agreed on next steps for the rollout schedule.\n";

/// Resolves the repo-root Qwen GGUF path from this crate's manifest dir
/// (`crates/myna-llm` -> repo root -> `models`), matching the convention
/// used by `tests/language.rs`.
fn qwen_model_path() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../models/qwen2.5-3b-instruct/qwen2.5-3b-instruct-q4_k_m.gguf")
}

/// A minimal template used purely to exercise the engine, not to produce a
/// polished summary.
fn smoke_test_template() -> Template {
    Template {
        name: "engine-e2e-check".to_string(),
        description: "model-gated engine smoke test".to_string(),
        prompt: "Summarize the meeting transcript below in one short sentence.\n\nTranscript:\n{transcript}\n\nSummary:".to_string(),
        section_schema: None,
        label: None,
        emoji: None,
    }
}

/// Repeats [`FIXTURE_LINE`] `count` times into one transcript string.
fn repeated_transcript(count: usize) -> String {
    FIXTURE_LINE.repeat(count)
}

#[test]
#[ignore = "model-gated: requires models/qwen2.5-3b-instruct/*.gguf on disk"]
fn transcript_exceeding_n_batch_no_longer_aborts_and_produces_non_empty_summary() {
    // Arrange: ~400 repeats of a ~20-token line is comfortably north of
    // 8,000 tokens — several times past the 2048-token `n_batch` default
    // that the old, unchunked `prefill` submitted in a single
    // `llama_decode` call and aborted the process on. `n_ctx` stays at its
    // 32,768 production default so this exercises the exact single-shot
    // (non-map-reduce) code path a real 30+ minute meeting takes: the
    // prompt fits the context window, it just doesn't fit one batch.
    let transcript = repeated_transcript(400);
    let template = smoke_test_template();
    let ctx = RenderContext {
        transcript,
        duration: "35:00".to_string(),
        title: "Regression check".to_string(),
        language: "English".to_string(),
    };
    let opts = SummaryOptions {
        max_tokens: 24,
        ..SummaryOptions::default()
    };
    let summarizer = Summarizer::load(&qwen_model_path()).expect("model should load");
    let cancel = AtomicBool::new(false);

    // Act
    let mut collected = String::new();
    let result = summarizer.summarize_transcript(&template, &ctx, &opts, &cancel, |tok| {
        collected.push_str(tok);
    });

    // Assert
    let markdown = result.expect("summarization of an over-n_batch transcript must not error");
    assert!(!markdown.trim().is_empty());
    assert_eq!(markdown, collected);
}

#[test]
#[ignore = "model-gated: requires models/qwen2.5-3b-instruct/*.gguf on disk"]
fn transcript_exceeding_n_ctx_falls_back_to_map_reduce_and_produces_non_empty_summary() {
    // Arrange: `n_ctx` is deliberately reduced to 4096 (rather than the
    // 32,768 production default) purely to keep this model-gated test's
    // wall-clock reasonable — forcing map-reduce against the real default
    // would need a transcript in the tens of thousands of tokens. The
    // map-reduce code path itself (`summarize_transcript`'s chunk/reduce
    // logic) is identical regardless of `n_ctx`'s value, so this still
    // genuinely exercises chunk splitting, per-chunk summarization, and
    // the final reduce pass — just at a smaller, faster scale. ~700
    // repeats of the fixture line comfortably clears this smaller
    // context's ~4000-token budget several times over.
    let transcript = repeated_transcript(700);
    let template = smoke_test_template();
    let ctx = RenderContext {
        transcript,
        duration: "35:00".to_string(),
        title: "Map-reduce regression check".to_string(),
        language: "English".to_string(),
    };
    let opts = SummaryOptions {
        n_ctx: 4096,
        max_tokens: 24,
        ..SummaryOptions::default()
    };
    let summarizer = Summarizer::load(&qwen_model_path()).expect("model should load");
    let cancel = AtomicBool::new(false);

    // Act
    let result = summarizer.summarize_transcript(&template, &ctx, &opts, &cancel, |_| {});

    // Assert
    let markdown =
        result.expect("map-reduce summarization of an over-n_ctx transcript must not error");
    assert!(!markdown.trim().is_empty());
}

#[test]
#[ignore = "model-gated: requires models/qwen2.5-3b-instruct/*.gguf on disk"]
fn cancellation_mid_map_reduce_still_stops_the_operation() {
    // Arrange: same over-n_ctx setup as the map-reduce test above, so this
    // is guaranteed to still be working through chunks (map phase or
    // reduce phase) when `cancel` flips partway through.
    let transcript = repeated_transcript(700);
    let template = smoke_test_template();
    let ctx = RenderContext {
        transcript,
        duration: "35:00".to_string(),
        title: "Cancellation regression check".to_string(),
        language: "English".to_string(),
    };
    let opts = SummaryOptions {
        n_ctx: 4096,
        max_tokens: 64,
        ..SummaryOptions::default()
    };
    let summarizer = Summarizer::load(&qwen_model_path()).expect("model should load");
    let cancel = Arc::new(AtomicBool::new(false));

    // Act: run the (slow, multi-chunk) summarization on a worker thread and
    // flip `cancel` shortly after it starts, from the test thread.
    let worker_cancel = Arc::clone(&cancel);
    let worker = std::thread::spawn(move || {
        summarizer.summarize_transcript(&template, &ctx, &opts, &worker_cancel, |_| {})
    });
    std::thread::sleep(Duration::from_millis(200));
    cancel.store(true, Ordering::SeqCst);
    let result = worker.join().expect("worker thread must not panic");

    // Assert
    assert!(matches!(result, Err(LlmError::Cancelled)));
}

/// Ceiling on new RSS a second `summarize` call on one `Summarizer` may
/// allocate. Before the inference-worker rework, every call built a fresh
/// `LlamaContext` at the 32,768-token production default (~1.2 GB of KV
/// cache) and freed it on return, so this was exceeded by an order of
/// magnitude.
const MAX_CONTEXT_CHURN_MB: u64 = 100;

/// Point-sample of the current process's resident set size, in MB.
fn current_rss_mb() -> u64 {
    let pid = sysinfo::Pid::from_u32(std::process::id());
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[pid]),
        false,
        sysinfo::ProcessRefreshKind::nothing().with_memory(),
    );
    system
        .process(pid)
        .expect("the current process must be observable via sysinfo")
        .memory()
        / (1024 * 1024)
}

/// Runs `run` on the current thread while a dedicated sampler thread
/// records peak process RSS every 5 ms; returns the output alongside that
/// peak (MB). Peak-vs-pre-call baseline, rather than end-to-end delta, is
/// the discriminator: the pre-fix code freed each context on return, so
/// RSS *between* calls could look flat even while each call churned a
/// fresh ~1.2 GB allocation *during* itself.
fn peak_rss_mb_during<T>(run: impl FnOnce() -> T) -> (T, u64) {
    let peak = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let (sampler_peak, sampler_stop) = (Arc::clone(&peak), Arc::clone(&stop));
    let sampler = std::thread::spawn(move || {
        let pid = sysinfo::Pid::from_u32(std::process::id());
        let mut system = sysinfo::System::new();
        while !sampler_stop.load(Ordering::Relaxed) {
            system.refresh_processes_specifics(
                sysinfo::ProcessesToUpdate::Some(&[pid]),
                false,
                sysinfo::ProcessRefreshKind::nothing().with_memory(),
            );
            if let Some(process) = system.process(pid) {
                sampler_peak.fetch_max(process.memory() / (1024 * 1024), Ordering::Relaxed);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    });
    let output = run();
    stop.store(true, Ordering::Relaxed);
    sampler.join().expect("RSS sampler thread must not panic");
    (output, peak.load(Ordering::Relaxed))
}

#[test]
#[ignore = "model-gated: requires models/qwen2.5-3b-instruct/*.gguf on disk"]
fn consecutive_summarize_calls_reuse_one_context() {
    // Arrange: ~400 repeats of a ~20-token line (~8k tokens) fits well
    // inside the 32k production context, so both calls take the
    // single-shot path — the exact path that used to allocate a fresh
    // 1.2 GB `LlamaContext` per call.
    let prompt = repeated_transcript(400);
    let opts = SummaryOptions {
        max_tokens: 24,
        ..SummaryOptions::default()
    };
    let summarizer = Summarizer::load(&qwen_model_path()).expect("model should load");
    let cancel = AtomicBool::new(false);

    // Act: call 1 doubles as the warm-up that pages in model weights, so
    // call 2's measurement is not charged for first-touch faults.
    let (first, peak_1) = peak_rss_mb_during(|| {
        summarizer
            .summarize(&prompt, &opts, &cancel, |_| {})
            .expect("first summarize must succeed")
    });
    let baseline = current_rss_mb();
    let (second, peak_2) = peak_rss_mb_during(|| {
        summarizer
            .summarize(&prompt, &opts, &cancel, |_| {})
            .expect("second summarize must succeed")
    });
    let churn_during_second = peak_2.saturating_sub(baseline);

    println!(
        "call 1: {} chars, peak RSS {peak_1} MB; call 2: baseline {baseline} MB, \
         peak {peak_2} MB, churn within call {churn_during_second} MB \
         (limit {MAX_CONTEXT_CHURN_MB} MB)",
        first.len()
    );

    // Assert
    assert!(!first.trim().is_empty());
    assert!(!second.trim().is_empty());
    assert!(
        churn_during_second < MAX_CONTEXT_CHURN_MB,
        "the second summarize call allocated {churn_during_second} MB of new RSS; \
         a ~1.2 GB figure means a fresh LlamaContext is built per call instead \
         of one being reused across calls"
    );
}
