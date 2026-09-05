//! Model-backed `myna-llm` pipeline tests: rendering every built-in template
//! and summarizing against the real Qwen2.5 GGUF, plus cooperative
//! cancellation mid-generation.
//!
//! `#[ignore]`d because they require the downloaded Qwen2.5 GGUF (see
//! `scripts/download-models.sh`) and are slow relative to the rest of the
//! suite. The test self-skips (passes trivially, printing why) when
//! `myna_integration_tests::models_present()` is `false`.
//!
//! Both scenarios below run inside one `#[test]` function rather than two,
//! and share a single [`Summarizer`]: `llama_cpp_2::llama_backend::LlamaBackend`
//! is a process-wide singleton, so a second `Summarizer::load` in the same
//! process (as would happen with two separate `#[test]` functions running
//! on different threads) fails with `Load("BackendAlreadyInitialized")`.
//!
//! Run with `cargo test -p myna-integration-tests --release --locked --
//! --ignored`. A debug build of llama.cpp is drastically slower and may
//! look like a hang.

use std::sync::atomic::{AtomicBool, Ordering};

use myna_integration_tests::{models_present, qwen_gguf, templates_dir};
use myna_llm::{list_templates, resolve, LlmError, RenderContext, Summarizer, SummaryOptions};

/// Number of built-in JSON summary templates shipped in `templates/`
/// (`action-items`, `decisions`, `key-points`, `meeting-notes`).
const BUILT_IN_TEMPLATE_COUNT: usize = 4;
/// Token budget used across the summarize tests, small enough to keep the
/// `--ignored` suite fast while still exercising real generation.
const MAX_TOKENS: u32 = 64;
/// Number of tokens to let the cancellation scenario generate before it
/// requests cancellation.
const CANCEL_AFTER_TOKEN_COUNT: usize = 5;

/// A short, fixed fake meeting transcript used across the summarize tests,
/// so results are deterministic given the same model and seed.
fn fake_transcript() -> String {
    concat!(
        "Alice: Let's kick off the sprint planning meeting.\n",
        "Bob: Sure, first let's review last sprint's velocity.\n",
        "Alice: We closed eighteen points, two below target.\n",
        "Carol: The API migration ticket slipped, that's the gap.\n",
        "Bob: Agreed, let's carry it over and re-estimate it.\n",
        "Alice: Carol, can you re-estimate the migration by tomorrow?\n",
        "Carol: Yes, I'll have a new estimate by end of day.\n",
        "Bob: Next, the new onboarding flow design is ready for review.\n",
        "Alice: Let's timebox review to fifteen minutes on Wednesday.\n",
        "Carol: Works for me, I'll send the Figma link today.\n",
        "Bob: Also, we decided to drop the legacy export feature.\n",
        "Alice: Confirmed, it has had zero usage for six months.\n",
        "Carol: I'll file the removal ticket after this call.\n",
        "Bob: One risk: the third-party auth provider is deprecating an endpoint.\n",
        "Alice: Let's spike on the replacement early next sprint.\n",
        "Carol: I can take that spike, it overlaps with my other work.\n",
        "Bob: Great, action items: Carol re-estimates migration, files removal ticket, and spikes on auth.\n",
        "Alice: I'll schedule the design review for Wednesday.\n",
        "Bob: Sounds good, anything else before we close?\n",
        "Alice: No, that's everything. Thanks, everyone.\n",
    )
    .to_string()
}

#[test]
#[ignore]
fn summarize_pipeline_renders_every_template_and_honors_cancellation() {
    // Arrange
    if !models_present() {
        eprintln!("skipping: models not present (see scripts/download-models.sh)");
        return;
    }
    let summarizer = Summarizer::load(&qwen_gguf()).expect("Qwen2.5 GGUF loads");
    let templates = list_templates(&templates_dir()).expect("built-in templates load");
    assert_eq!(
        templates.len(),
        BUILT_IN_TEMPLATE_COUNT,
        "expected exactly the built-in templates in templates/"
    );
    let ctx = RenderContext {
        transcript: fake_transcript(),
        duration: "15m".to_string(),
        title: "Sprint Planning".to_string(),
        language: resolve(None).1.to_string(),
        instructions: None,
    };
    let opts = SummaryOptions {
        max_tokens: MAX_TOKENS,
        ..Default::default()
    };

    // Act / Assert: every built-in template renders a prompt the model can
    // summarize into non-empty output while streaming at least one token.
    for template in &templates {
        let prompt = template.render(&ctx);
        let cancel = AtomicBool::new(false);
        let mut token_count = 0usize;

        let output = summarizer
            .summarize(&prompt, &opts, &cancel, |_piece| token_count += 1)
            .unwrap_or_else(|err| panic!("summarize failed for template {}: {err}", template.name));

        assert!(
            !output.trim().is_empty(),
            "expected non-empty summary output for template {}",
            template.name
        );
        assert!(
            token_count >= 1,
            "expected on_token to fire at least once for template {}",
            template.name
        );
    }

    // Act / Assert: setting the cancel flag mid-generation stops decoding
    // and surfaces `LlmError::Cancelled`, reusing the same loaded model.
    let prompt = format!(
        "Summarize this transcript in one sentence.\n\nTranscript:\n{}",
        ctx.transcript
    );
    let cancel = AtomicBool::new(false);
    let mut token_count = 0usize;

    let result = summarizer.summarize(&prompt, &opts, &cancel, |_piece| {
        token_count += 1;
        if token_count == CANCEL_AFTER_TOKEN_COUNT {
            cancel.store(true, Ordering::SeqCst);
        }
    });

    assert!(
        matches!(result, Err(LlmError::Cancelled)),
        "expected Err(LlmError::Cancelled), got {result:?}"
    );
}
