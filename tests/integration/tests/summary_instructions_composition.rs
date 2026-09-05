//! Prompt-level regression tests for user-authored summary instructions,
//! exercising the REAL composition path (`Template::render`, `RenderContext`
//! and `SummaryInstructions::compose`) against the built-in `key-points`
//! template on disk — without loading any model weights.
//!
//! Deliberately **not** `#[ignore]`d: unlike the sibling model-backed tests,
//! these need no downloaded GGUF/ONNX artifacts and run in milliseconds, so
//! they guard the prompt contract in the default `cargo test --workspace`
//! pass.
//!
//! Layer limitation: the Tauri command's `resolve_instructions` lives in the
//! `myna-app` crate, which this harness does not (and should not) link. Its
//! semantics are reproduced here at the prompt level — combine mode
//! (`include_general: true`) yields `SummaryInstructions::new(Some(general),
//! Some(specific))`, ignore mode (`include_general: false`) yields
//! `SummaryInstructions::new(None, Some(specific))`, and empty/whitespace
//! fields are filtered to `None` before reaching `compose()`. The function
//! itself is unit-tested in `app/src-tauri/src/commands/summary.rs`; these
//! tests pin what the resolved value does to the final prompt.
//!
//! The header strings below are duplicated from `myna-llm`'s private
//! constants on purpose: they are the observable prompt contract the model
//! (and users) see, and a regression test must fail if they silently change.

use myna_integration_tests::templates_dir;
use myna_llm::{list_templates, resolve, RenderContext, SummaryInstructions, Template};

/// Header of the general-guidelines block, per `SummaryInstructions::compose`.
const GENERAL_HEADER: &str = "General guidelines for this summary:";
/// Header of the per-request instructions block.
const SPECIFIC_HEADER: &str = concat!(
    "Instructions for this specific request (they take precedence over ",
    "the general guidelines above where they conflict):"
);
/// Separator that closes the instructions block, after which the rendered
/// template text begins.
const SEPARATOR: &str = "\n\n---\n\n";
/// Trailing generation cue of the built-in `key-points` template; must stay
/// the final line of the composed prompt.
const TRAILING_CUE: &str = "Key Points:";

fn key_points_template() -> Template {
    let templates = list_templates(&templates_dir()).expect("built-in templates load");
    templates
        .into_iter()
        .find(|t| t.name == "key-points")
        .expect("key-points is a built-in template")
}

fn ctx_with(instructions: Option<SummaryInstructions>) -> RenderContext {
    RenderContext {
        transcript: "Alice: Ship the composition test.\nBob: Agreed, tomorrow.".to_string(),
        duration: "10m".to_string(),
        title: "Composition Check".to_string(),
        language: resolve(None).1.to_string(),
        instructions,
    }
}

#[test]
fn combine_mode_orders_general_then_specific_then_template_with_cue_last() {
    let template = key_points_template();
    let plain = template.render(&ctx_with(None));

    let instructions = SummaryInstructions::new(
        Some("Always list open questions.".to_string()),
        Some("Focus on the budget discussion.".to_string()),
    );
    let prompt = template.render(&ctx_with(Some(instructions)));

    let general_at = prompt
        .find(GENERAL_HEADER)
        .expect("combine mode must include the general block header");
    let specific_at = prompt
        .find(SPECIFIC_HEADER)
        .expect("combine mode must include the specific block header");
    let separator_at = prompt
        .find(SEPARATOR)
        .expect("instructions block must end with the --- separator");

    assert!(
        general_at < specific_at && specific_at < separator_at,
        "expected general block, then specific block, then separator; got \
         general={general_at}, specific={specific_at}, separator={separator_at}"
    );
    assert!(
        prompt[general_at + GENERAL_HEADER.len()..].starts_with("\nAlways list open questions."),
        "general text must follow its header line: {prompt}"
    );
    assert!(
        prompt[specific_at + SPECIFIC_HEADER.len()..]
            .starts_with("\nFocus on the budget discussion."),
        "specific text must follow its header line: {prompt}"
    );
    let template_after_separator = &prompt[separator_at + SEPARATOR.len()..];
    assert!(
        template_after_separator == plain,
        "text after the separator must be the template-only render"
    );
    assert!(
        prompt.ends_with(TRAILING_CUE),
        "the template's trailing generation cue must remain the last line"
    );
}

#[test]
fn ignore_general_mode_drops_general_block_and_keeps_specific() {
    let template = key_points_template();
    // Mirrors `resolve_instructions` with `include_general: false`: the
    // guidelines never reach `SummaryInstructions` at all.
    let instructions =
        SummaryInstructions::new(None, Some("Focus on the budget discussion.".to_string()));
    let prompt = template.render(&ctx_with(Some(instructions)));

    assert!(
        !prompt.contains(GENERAL_HEADER),
        "ignore mode must omit the general block header: {prompt}"
    );
    let specific_at = prompt
        .find(SPECIFIC_HEADER)
        .expect("ignore mode must still include the specific block");
    let separator_at = prompt
        .find(SEPARATOR)
        .expect("instructions block must end with the --- separator");
    assert!(
        specific_at < separator_at,
        "specific block must precede the separator"
    );
    assert!(
        prompt.ends_with(TRAILING_CUE),
        "trailing cue must remain last"
    );
}

#[test]
fn empty_instructions_render_byte_identical_to_none() {
    let template = key_points_template();
    let plain = template.render(&ctx_with(None));

    // Both fields absent...
    let none_prompt = template.render(&ctx_with(Some(SummaryInstructions::default())));
    assert_eq!(
        none_prompt, plain,
        "default instructions must not alter the prompt"
    );

    // ...and present but blank (what `resolve_instructions` filters to
    // `None` upstream; `compose` must be equally inert).
    let blank_prompt = template.render(&ctx_with(Some(SummaryInstructions::new(
        Some("   \n\t ".to_string()),
        Some(String::new()),
    ))));
    assert_eq!(
        blank_prompt, plain,
        "whitespace-only instructions must leave the prompt byte-identical"
    );
}
