//! Integration tests for the summary output language catalog: known-code
//! resolution, unknown-code fallback, and (model-gated) end-to-end
//! generation of a non-English summary.

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use myna_llm::{
    label_for, resolve, RenderContext, Summarizer, SummaryOptions, Template,
    DEFAULT_SUMMARY_LANGUAGE, SUMMARY_LANGUAGES,
};

#[test]
fn resolve_of_a_known_code_returns_its_code_and_label() {
    // Act
    let resolved = resolve(Some("fr"));

    // Assert
    assert_eq!(resolved, ("fr", "French"));
}

#[test]
fn resolve_of_none_falls_back_to_default() {
    // Arrange
    let default_label =
        label_for(DEFAULT_SUMMARY_LANGUAGE).expect("default language should have a label");

    // Act
    let resolved = resolve(None);

    // Assert
    assert_eq!(resolved, (DEFAULT_SUMMARY_LANGUAGE, default_label));
}

#[test]
fn resolve_of_an_unknown_code_falls_back_to_default_rather_than_leaking_it() {
    // Arrange
    let default_label =
        label_for(DEFAULT_SUMMARY_LANGUAGE).expect("default language should have a label");

    // Act
    let (code, label) = resolve(Some("xx"));

    // Assert
    assert_eq!((code, label), (DEFAULT_SUMMARY_LANGUAGE, default_label));
    assert_ne!(code, "xx");
}

#[test]
fn label_for_returns_none_for_an_unrecognized_code() {
    // Act
    let label = label_for("xx");

    // Assert
    assert_eq!(label, None);
}

#[test]
fn default_summary_language_is_present_in_summary_languages() {
    // Act & Assert
    assert!(SUMMARY_LANGUAGES
        .iter()
        .any(|language| language.code == DEFAULT_SUMMARY_LANGUAGE));
}

#[test]
fn summary_languages_includes_the_curated_set() {
    // Arrange
    let mut expected = vec!["en", "fr", "es", "de", "it", "pt", "nl"];
    expected.sort_unstable();

    // Act
    let mut actual: Vec<&str> = SUMMARY_LANGUAGES
        .iter()
        .map(|language| language.code)
        .collect();
    actual.sort_unstable();

    // Assert
    assert_eq!(actual, expected);
}

/// Resolves the repo-root Qwen GGUF path from this crate's manifest dir
/// (`crates/myna-llm` -> repo root -> `models`).
fn qwen_model_path() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../models/qwen2.5-3b-instruct/qwen2.5-3b-instruct-q4_k_m.gguf")
}

#[test]
#[ignore = "model-gated: requires models/qwen2.5-3b-instruct/*.gguf on disk"]
fn summarizes_a_french_transcript_and_produces_non_empty_output() {
    // Arrange
    let (_code, label) = resolve(Some("fr"));
    let template = Template {
        name: "french-e2e-check".to_string(),
        description: "model-gated french summarization smoke test".to_string(),
        prompt: "Summarize the transcript below in a few bullet points.\n\nTranscript:\n{transcript}\n\nSummary:".to_string(),
        section_schema: None,
        label: None,
        emoji: None,
    };
    let ctx = RenderContext {
        transcript: "Alice: Nous avons décidé de lancer le produit vendredi. Bob: D'accord, je m'occupe du déploiement.".to_string(),
        duration: "".to_string(),
        title: "".to_string(),
        language: label.to_string(),
    };
    let rendered = template.render(&ctx);
    let summarizer = Summarizer::load(&qwen_model_path()).expect("model should load");

    // Act
    let mut collected = String::new();
    summarizer
        .summarize(
            &rendered,
            &SummaryOptions::default(),
            &Arc::new(AtomicBool::new(false)),
            |tok| collected.push_str(tok),
        )
        .expect("summarize should succeed");

    // Assert
    assert!(!collected.trim().is_empty());
}

#[test]
#[ignore = "model-gated: requires models/qwen2.5-3b-instruct/*.gguf on disk"]
fn summarizes_an_english_transcript_and_produces_non_empty_output() {
    // Arrange
    let (_code, label) = resolve(Some("en"));
    let template = Template {
        name: "english-e2e-check".to_string(),
        description: "model-gated english summarization smoke test".to_string(),
        prompt: "Summarize the transcript below in a few bullet points.\n\nTranscript:\n{transcript}\n\nSummary:".to_string(),
        section_schema: None,
        label: None,
        emoji: None,
    };
    let ctx = RenderContext {
        transcript: "Alice: We decided to ship the product on Friday. Bob: Sounds good, I'll own the rollout.".to_string(),
        duration: "".to_string(),
        title: "".to_string(),
        language: label.to_string(),
    };
    let rendered = template.render(&ctx);
    let summarizer = Summarizer::load(&qwen_model_path()).expect("model should load");

    // Act
    let mut collected = String::new();
    summarizer
        .summarize(
            &rendered,
            &SummaryOptions::default(),
            &Arc::new(AtomicBool::new(false)),
            |tok| collected.push_str(tok),
        )
        .expect("summarize should succeed");

    // Assert
    assert!(!collected.trim().is_empty());
}
