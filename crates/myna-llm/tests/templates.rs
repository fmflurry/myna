//! Integration tests for template loading, validation, rendering, and
//! discovery against both the real `templates/` directory and malformed
//! fixtures.

use std::path::{Path, PathBuf};

use myna_llm::{list_templates, LlmError, RenderContext, Template};

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
