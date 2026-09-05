//! Integration tests for template loading, validation, rendering, and
//! discovery against both the real `templates/` directory and malformed
//! fixtures.

use std::path::{Path, PathBuf};

use myna_llm::{list_templates, LlmError, RenderContext, SummaryInstructions, Template};

const BUILTIN_TEMPLATE_NAMES: [&str; 4] =
    ["action-items", "decisions", "key-points", "meeting-notes"];

/// Resolve the repo-root `templates/` directory from this crate's manifest
/// dir (`crates/myna-llm` -> repo root -> `templates`).
fn templates_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("templates")
}

/// True if `text` contains an unsubstituted `{...}` placeholder token.
fn has_leftover_placeholder(text: &str) -> bool {
    for (start, ch) in text.char_indices() {
        if ch == '{' && text[start..].contains('}') {
            return true;
        }
    }
    false
}

#[test]
fn list_templates_returns_the_four_builtins_sorted_and_excludes_schema() {
    // Arrange
    let dir = templates_dir();

    // Act
    let templates = list_templates(&dir).expect("list_templates should succeed");

    // Assert
    let names: Vec<&str> = templates.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, BUILTIN_TEMPLATE_NAMES);
}

#[test]
fn every_builtin_template_renders_without_leftover_placeholders() {
    // Arrange
    let dir = templates_dir();
    let templates = list_templates(&dir).expect("list_templates should succeed");
    let ctx = RenderContext {
        transcript: "Alice: let's ship it. Bob: agreed, I'll own the rollout.".to_string(),
        duration: "30 minutes".to_string(),
        title: "Weekly Sync".to_string(),
        language: "French".to_string(),
        instructions: None,
    };
    assert_eq!(templates.len(), BUILTIN_TEMPLATE_NAMES.len());

    // Act
    let rendered: Vec<String> = templates.iter().map(|t| t.render(&ctx)).collect();

    // Assert
    for (template, output) in templates.iter().zip(rendered.iter()) {
        assert!(
            !has_leftover_placeholder(output),
            "template '{}' left an unsubstituted placeholder in rendered output: {output}",
            template.name
        );
    }
}

#[test]
fn template_without_language_placeholder_gets_directive_appended() {
    // Arrange
    let template = Template {
        name: "no-language-placeholder".to_string(),
        description: "prompt without a {language} placeholder".to_string(),
        prompt: "Summarize {transcript}.".to_string(),
        section_schema: None,
        label: None,
        emoji: None,
    };
    let ctx = RenderContext {
        transcript: "hi".to_string(),
        duration: "".to_string(),
        title: "".to_string(),
        language: "French".to_string(),
        instructions: None,
    };

    // Act
    let rendered = template.render(&ctx);

    // Assert
    assert!(rendered.contains("Write your entire response in French."));
}

#[test]
fn template_with_language_placeholder_is_not_double_directed() {
    // Arrange
    let template = Template {
        name: "has-language-placeholder".to_string(),
        description: "prompt with a {language} placeholder".to_string(),
        prompt: "Summarize {transcript} in {language}.".to_string(),
        section_schema: None,
        label: None,
        emoji: None,
    };
    let ctx = RenderContext {
        transcript: "hi".to_string(),
        duration: "".to_string(),
        title: "".to_string(),
        language: "French".to_string(),
        instructions: None,
    };

    // Act
    let rendered = template.render(&ctx);

    // Assert
    assert!(!rendered.contains("Write your entire response in French."));
    assert!(rendered.contains("French"));
}

#[test]
fn renders_with_each_supported_language_produces_the_correct_directive() {
    // Arrange
    let languages = [("en", "English"), ("fr", "French"), ("de", "German")];
    let template = Template {
        name: "language-directive-check".to_string(),
        description: "prompt without a {language} placeholder".to_string(),
        prompt: "Summarize {transcript}.".to_string(),
        section_schema: None,
        label: None,
        emoji: None,
    };

    for (_code, label) in languages {
        let ctx = RenderContext {
            transcript: "team update".to_string(),
            duration: "".to_string(),
            title: "".to_string(),
            language: label.to_string(),
            instructions: None,
        };

        // Act
        let rendered = template.render(&ctx);

        // Assert
        assert!(
            rendered.contains(&format!("Write your entire response in {label}.")),
            "expected directive for {label} in rendered output: {rendered}"
        );
    }
}

#[test]
fn load_rejects_a_template_missing_the_transcript_placeholder() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir should be created");
    let path = dir.path().join("broken.json");
    std::fs::write(
        &path,
        r#"{
            "name": "broken",
            "description": "missing the transcript placeholder",
            "prompt": "Summarize {title} in {duration}."
        }"#,
    )
    .expect("fixture should be written");

    // Act
    let result = Template::load(&path);

    // Assert
    assert!(matches!(result, Err(LlmError::Template(_))));
}

#[test]
fn load_rejects_a_template_with_a_non_kebab_case_name() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir should be created");
    let path = dir.path().join("broken.json");
    std::fs::write(
        &path,
        r#"{
            "name": "Broken_Name",
            "description": "name is not kebab-case",
            "prompt": "Summarize {transcript}."
        }"#,
    )
    .expect("fixture should be written");

    // Act
    let result = Template::load(&path);

    // Assert
    assert!(matches!(result, Err(LlmError::Template(_))));
}

#[test]
fn load_rejects_a_template_with_an_unknown_placeholder() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir should be created");
    let path = dir.path().join("broken.json");
    std::fs::write(
        &path,
        r#"{
            "name": "broken",
            "description": "prompt references an unsupported placeholder",
            "prompt": "Summarize {transcript} for {audience}."
        }"#,
    )
    .expect("fixture should be written");

    // Act
    let result = Template::load(&path);

    // Assert
    assert!(matches!(result, Err(LlmError::Template(_))));
}

#[test]
fn template_with_label_and_emoji_round_trips_through_json() {
    // Arrange
    let template = Template {
        name: "with-label".to_string(),
        description: "template carrying a label and emoji".to_string(),
        prompt: "Summarize {transcript}.".to_string(),
        section_schema: None,
        label: Some("Notes".to_string()),
        emoji: Some("📝".to_string()),
    };

    // Act
    let json = serde_json::to_string(&template).expect("template should serialize");
    let round_tripped: Template = serde_json::from_str(&json).expect("template should deserialize");

    // Assert
    assert_eq!(round_tripped.label.as_deref(), Some("Notes"));
    assert_eq!(round_tripped.emoji.as_deref(), Some("📝"));
    round_tripped
        .validate()
        .expect("round-tripped template should validate");
}

#[test]
fn template_without_label_or_emoji_still_loads_and_validates() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir should be created");
    let path = dir.path().join("legacy.json");
    std::fs::write(
        &path,
        r#"{
            "name": "legacy",
            "description": "a template authored before label/emoji existed",
            "prompt": "Summarize {transcript}."
        }"#,
    )
    .expect("fixture should be written");

    // Act
    let template = Template::load(&path).expect("legacy template should load");

    // Assert
    assert_eq!(template.label, None);
    assert_eq!(template.emoji, None);
}

#[test]
fn load_rejects_a_template_with_an_over_long_label() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir should be created");
    let path = dir.path().join("broken.json");
    std::fs::write(
        &path,
        r#"{
            "name": "broken",
            "description": "label is longer than the display tab allows",
            "prompt": "Summarize {transcript}.",
            "label": "This Label Is Far Too Long For A Tab"
        }"#,
    )
    .expect("fixture should be written");

    // Act
    let result = Template::load(&path);

    // Assert
    assert!(matches!(result, Err(LlmError::Template(_))));
}

#[test]
fn load_rejects_a_template_with_a_multi_scalar_emoji_sequence() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir should be created");
    let path = dir.path().join("broken.json");
    std::fs::write(
        &path,
        r#"{
            "name": "broken",
            "description": "emoji is a multi-person ZWJ sequence, not a single emoji",
            "prompt": "Summarize {transcript}.",
            "emoji": "👨‍👩‍👧‍👦"
        }"#,
    )
    .expect("fixture should be written");

    // Act
    let result = Template::load(&path);

    // Assert
    assert!(matches!(result, Err(LlmError::Template(_))));
}

#[test]
fn load_rejects_a_template_with_an_empty_label() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir should be created");
    let path = dir.path().join("broken.json");
    std::fs::write(
        &path,
        r#"{
            "name": "broken",
            "description": "label is present but blank",
            "prompt": "Summarize {transcript}.",
            "label": "   "
        }"#,
    )
    .expect("fixture should be written");

    // Act
    let result = Template::load(&path);

    // Assert
    assert!(matches!(result, Err(LlmError::Template(_))));
}

#[test]
fn load_rejects_a_template_with_an_empty_emoji() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir should be created");
    let path = dir.path().join("broken.json");
    std::fs::write(
        &path,
        r#"{
            "name": "broken",
            "description": "emoji is present but blank",
            "prompt": "Summarize {transcript}.",
            "emoji": ""
        }"#,
    )
    .expect("fixture should be written");

    // Act
    let result = Template::load(&path);

    // Assert
    assert!(matches!(result, Err(LlmError::Template(_))));
}

#[test]
fn every_builtin_template_carries_its_expected_label_and_emoji() {
    // Arrange
    let dir = templates_dir();
    let expected: [(&str, &str, &str); 4] = [
        ("action-items", "Action Items", "✅"),
        ("decisions", "Decisions", "⚖️"),
        ("key-points", "Key Points", "🔑"),
        ("meeting-notes", "Notes", "📝"),
    ];

    // Act
    let templates = list_templates(&dir).expect("list_templates should succeed");

    // Assert
    for (name, label, emoji) in expected {
        let template = templates
            .iter()
            .find(|t| t.name == name)
            .unwrap_or_else(|| panic!("builtin template '{name}' should be present"));
        assert_eq!(template.label.as_deref(), Some(label));
        assert_eq!(template.emoji.as_deref(), Some(emoji));
    }
}

/// A template whose prompt ends in a trailing generation cue, mirroring
/// the built-ins ("Key Points:" etc.).
fn cue_terminated_template() -> Template {
    Template {
        name: "cue-terminated".to_string(),
        description: "prompt ending in a generation cue".to_string(),
        prompt:
            "Summarize the transcript in {language}.\n\nTranscript:\n{transcript}\n\nKey Points:"
                .to_string(),
        section_schema: None,
        label: None,
        emoji: None,
    }
}

#[test]
fn render_without_instructions_is_byte_identical_to_the_template_only_prompt() {
    // Arrange: the exact pre-change render for this prompt/ctx pair,
    // written out literally so a regression in the None path is caught.
    let template = cue_terminated_template();
    let expected = "Summarize the transcript in French.\n\nTranscript:\nship it\n\nKey Points:";
    let without = RenderContext {
        transcript: "ship it".to_string(),
        duration: "".to_string(),
        title: "".to_string(),
        language: "French".to_string(),
        instructions: None,
    };
    let all_empty = RenderContext {
        instructions: Some(SummaryInstructions::new(
            Some("   ".to_string()),
            Some(String::new()),
        )),
        ..without.clone()
    };

    // Act / Assert: absent and present-but-all-empty both render exactly
    // the template-only prompt.
    assert_eq!(template.render(&without), expected);
    assert_eq!(template.render(&all_empty), expected);
}

#[test]
fn render_appends_language_directive_to_template_portion_when_instructions_present() {
    // Arrange: prompt without a {language} placeholder — the fallback
    // directive must stay attached to the template portion (after the
    // instructions block), not float to the end of the whole prompt.
    let template = Template {
        name: "no-language-placeholder".to_string(),
        description: "prompt without a {language} placeholder".to_string(),
        prompt: "Summarize {transcript}.".to_string(),
        section_schema: None,
        label: None,
        emoji: None,
    };
    let ctx = RenderContext {
        transcript: "ship it".to_string(),
        duration: "".to_string(),
        title: "".to_string(),
        language: "French".to_string(),
        instructions: Some(SummaryInstructions::new(
            Some("Be concise.".to_string()),
            None,
        )),
    };

    // Act
    let rendered = template.render(&ctx);

    // Assert
    assert_eq!(
        rendered,
        "General guidelines for this summary:\nBe concise.\n\n---\n\n\
         Summarize ship it.\n\nWrite your entire response in French."
    );
}

#[test]
fn render_with_instructions_places_block_first_and_keeps_trailing_cue_last() {
    // Arrange
    let template = cue_terminated_template();
    let ctx = RenderContext {
        transcript: "ship it".to_string(),
        duration: "".to_string(),
        title: "".to_string(),
        language: "French".to_string(),
        instructions: Some(SummaryInstructions::new(
            Some("Always name owners.".to_string()),
            Some("Focus on the budget discussion.".to_string()),
        )),
    };

    // Act
    let rendered = template.render(&ctx);

    // Assert: block lands before the template text, separated by the
    // `---` line, and the template's trailing cue remains the final line.
    assert!(rendered.starts_with("General guidelines for this summary:\nAlways name owners.\n\n"));
    assert!(rendered.contains("Focus on the budget discussion.\n\n---\n\n"));
    assert!(rendered
        .ends_with("Summarize the transcript in French.\n\nTranscript:\nship it\n\nKey Points:"));
    assert_eq!(
        rendered.lines().last().expect("non-empty render"),
        "Key Points:"
    );
}

#[test]
fn render_does_not_substitute_placeholder_like_braces_in_instruction_text() {
    // Arrange: instruction prose that *looks* like a placeholder must
    // survive verbatim — substitution only ever touches the template's
    // own prompt, and validation never sees instruction text at all.
    let template = cue_terminated_template();
    let ctx = RenderContext {
        transcript: "ship it".to_string(),
        duration: "".to_string(),
        title: "".to_string(),
        language: "French".to_string(),
        instructions: Some(SummaryInstructions::new(
            Some("Quote {transcript} and {anything} literally.".to_string()),
            None,
        )),
    };

    // Act
    let rendered = template.render(&ctx);

    // Assert: the instruction's braces are intact, while the template's
    // own {transcript} was substituted exactly once.
    assert!(rendered.contains("Quote {transcript} and {anything} literally."));
    assert_eq!(rendered.matches("ship it").count(), 1);
}

#[test]
fn every_builtin_template_renders_with_instructions_without_leftover_placeholders() {
    // Arrange
    let dir = templates_dir();
    let templates = list_templates(&dir).expect("list_templates should succeed");
    let ctx = RenderContext {
        transcript: "Alice: let's ship it. Bob: agreed, I'll own the rollout.".to_string(),
        duration: "30 minutes".to_string(),
        title: "Weekly Sync".to_string(),
        language: "French".to_string(),
        instructions: Some(SummaryInstructions::new(
            Some("Always list open questions with owners.".to_string()),
            Some("Focus on the rollout discussion.".to_string()),
        )),
    };
    assert_eq!(templates.len(), BUILTIN_TEMPLATE_NAMES.len());

    // Act
    let rendered: Vec<String> = templates.iter().map(|t| t.render(&ctx)).collect();

    // Assert
    for (template, output) in templates.iter().zip(rendered.iter()) {
        assert!(
            !has_leftover_placeholder(output),
            "template '{}' left an unsubstituted placeholder with instructions: {output}",
            template.name
        );
        assert!(
            output.starts_with("General guidelines for this summary:"),
            "template '{}' should lead with the instructions block",
            template.name
        );
    }
}
