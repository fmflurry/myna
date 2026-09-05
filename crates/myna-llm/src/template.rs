//! Loading, validating, rendering, and discovering JSON summary templates.
//!
//! Templates drive the prompt sent to the model for a given summary type
//! (key points, action items, decisions, meeting notes, or a user-added
//! type). Each template's `section_schema` documents the intended output
//! shape but is deliberately not enforced against generated output in this
//! phase: a local 7B-class model cannot be trusted to emit conformant JSON
//! without grammar-constrained decoding, which is out of scope here.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::LlmError;
use crate::instructions::SummaryInstructions;

/// The `{language}` placeholder token, factored out so [`PLACEHOLDERS`] and
/// [`Template::render`]'s presence check can't drift apart.
const LANGUAGE_PLACEHOLDER: &str = "{language}";

/// Placeholders recognized inside a template's `prompt` field.
pub const PLACEHOLDERS: [&str; 4] = [
    "{transcript}",
    "{duration}",
    "{title}",
    LANGUAGE_PLACEHOLDER,
];

const SCHEMA_FILE_NAME: &str = "schema.json";
const TEMPLATE_FILE_EXTENSION: &str = "json";

/// Maximum length, in trimmed characters, of a template's optional `label`.
/// `label` exists specifically to be short (1-2 words) so the UI can render
/// it as a compact tab; this cap keeps anyone from reintroducing a
/// sentence-length label the way `description` was being misused for tabs
/// before this field existed.
const MAX_TEMPLATE_LABEL_CHARS: usize = 24;

/// Maximum length, in Unicode scalar values (`char`s), of a template's
/// optional `emoji`. Most single emoji are one scalar, but a meaningful
/// chunk of commonly-used ones (e.g. `⚖️` = U+2696 SCALES + U+FE0F
/// VARIATION SELECTOR-16) are two scalars. Capping at 2 accepts a plain
/// emoji or a base-plus-variation-selector emoji while rejecting longer
/// multi-codepoint sequences (skin-tone modifiers, ZWJ family/profession
/// sequences) without doing full grapheme-cluster segmentation, which
/// would require a new dependency.
const MAX_TEMPLATE_EMOJI_CHARS: usize = 2;

/// A summary template: a prompt plus an optional description of the
/// intended output shape (`section_schema`).
///
/// `Template` crosses the Tauri IPC boundary in a later phase, so it must
/// remain both [`Serialize`] and [`Deserialize`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Template {
    pub name: String,
    pub description: String,
    pub prompt: String,
    #[serde(default)]
    pub section_schema: Option<Value>,
    /// Short (1-2 word) display label for compact UI tabs, e.g. `"Notes"`.
    /// Optional so user-authored templates predating this field keep
    /// working; the UI falls back to a title-cased `name` when absent.
    #[serde(default)]
    pub label: Option<String>,
    /// A single display emoji for compact UI tabs, e.g. `"📝"`. Optional so
    /// user-authored templates predating this field keep working; the UI
    /// falls back to a generic emoji when absent.
    #[serde(default)]
    pub emoji: Option<String>,
}

/// Values substituted into a template's placeholders when rendering.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RenderContext {
    pub transcript: String,
    pub duration: String,
    pub title: String,
    /// Display label of the requested output language (e.g. `"French"`),
    /// resolved via [`crate::resolve`] before rendering.
    pub language: String,
    /// User-authored instructions prepended to the rendered template text
    /// (see [`crate::SummaryInstructions::compose`]). `None` — or a value
    /// whose parts are all empty — leaves the prompt byte-identical to a
    /// template-only render.
    #[serde(default)]
    pub instructions: Option<SummaryInstructions>,
}

impl Template {
    /// Read `path`, parse it as JSON, and validate it.
    pub fn load(path: &Path) -> Result<Self, LlmError> {
        let raw = fs::read_to_string(path)?;
        let template: Self = serde_json::from_str(&raw)
            .map_err(|err| LlmError::Template(format!("{}: {err}", path.display())))?;
        template.validate()?;
        Ok(template)
    }

    /// Validate structural invariants beyond what JSON parsing alone
    /// guarantees: non-empty fields, a kebab-case `name`, a required
    /// `{transcript}` placeholder, and no unknown `{...}` tokens in `prompt`.
    pub fn validate(&self) -> Result<(), LlmError> {
        if self.name.trim().is_empty() {
            return Err(LlmError::Template("name must not be empty".to_string()));
        }
        if self.description.trim().is_empty() {
            return Err(LlmError::Template(
                "description must not be empty".to_string(),
            ));
        }
        if self.prompt.trim().is_empty() {
            return Err(LlmError::Template("prompt must not be empty".to_string()));
        }
        if !is_kebab_case(&self.name) {
            return Err(LlmError::Template(format!(
                "name '{}' must match ^[a-z0-9-]+$",
                self.name
            )));
        }
        if !self.prompt.contains("{transcript}") {
            return Err(LlmError::Template(
                "prompt must contain the {transcript} placeholder".to_string(),
            ));
        }
        if let Some(token) = first_unknown_placeholder(&self.prompt) {
            return Err(LlmError::Template(format!(
                "prompt contains unknown placeholder '{token}'"
            )));
        }
        if let Some(label) = &self.label {
            let trimmed = label.trim();
            if trimmed.is_empty() {
                return Err(LlmError::Template("label must not be empty".to_string()));
            }
            if trimmed.chars().count() > MAX_TEMPLATE_LABEL_CHARS {
                return Err(LlmError::Template(format!(
                    "label must be at most {MAX_TEMPLATE_LABEL_CHARS} characters"
                )));
            }
        }
        if let Some(emoji) = &self.emoji {
            if emoji.is_empty() {
                return Err(LlmError::Template("emoji must not be empty".to_string()));
            }
            if emoji.chars().count() > MAX_TEMPLATE_EMOJI_CHARS {
                return Err(LlmError::Template(format!(
                    "emoji must be at most {MAX_TEMPLATE_EMOJI_CHARS} Unicode scalar values"
                )));
            }
        }
        Ok(())
    }

    /// Substitute the known placeholders in `prompt` with values from `ctx`,
    /// then prepend `ctx.instructions`' composed block (when any) ahead of
    /// the rendered template text. A placeholder with no corresponding
    /// context field renders as an empty string (via `RenderContext`'s
    /// `Default`); unknown `{...}` tokens are left in place verbatim.
    /// Instruction text is never placeholder-substituted — its braces are
    /// inert user prose.
    ///
    /// Backward compatibility: if `prompt` does not reference
    /// [`LANGUAGE_PLACEHOLDER`] at all, a directive sentence naming
    /// `ctx.language` is appended to the rendered output, so templates
    /// written before this placeholder existed still produce output in the
    /// requested language. The directive stays attached to the template
    /// portion (instructions block first, then template + directive), and
    /// when `compose()` yields `None` the output is byte-identical to a
    /// template-only render.
    pub fn render(&self, ctx: &RenderContext) -> String {
        let rendered = self
            .prompt
            .replace("{transcript}", &ctx.transcript)
            .replace("{duration}", &ctx.duration)
            .replace("{title}", &ctx.title)
            .replace(LANGUAGE_PLACEHOLDER, &ctx.language);

        let template_portion = if self.prompt.contains(LANGUAGE_PLACEHOLDER) {
            rendered
        } else {
            format!(
                "{rendered}\n\nWrite your entire response in {}.",
                ctx.language
            )
        };

        match ctx
            .instructions
            .as_ref()
            .and_then(SummaryInstructions::compose)
        {
            Some(block) => format!("{block}{template_portion}"),
            None => template_portion,
        }
    }
}

/// True if `value` matches `^[a-z0-9-]+$`.
fn is_kebab_case(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Scan `prompt` for `{...}` tokens and return the first one that is not a
/// member of [`PLACEHOLDERS`], if any.
fn first_unknown_placeholder(prompt: &str) -> Option<String> {
    for (start, ch) in prompt.char_indices() {
        if ch != '{' {
            continue;
        }
        if let Some(len) = prompt[start..].find('}') {
            let token = &prompt[start..start + len + 1];
            if !PLACEHOLDERS.contains(&token) {
                return Some(token.to_string());
            }
        }
    }
    None
}

/// Load and validate every `*.json` template in `dir`, sorted by `name`.
///
/// `schema.json` is skipped by design (it describes templates, it is not
/// one). A file that fails to parse or fails validation is skipped with a
/// diagnostic rather than aborting discovery of the remaining templates.
pub fn list_templates(dir: &Path) -> Result<Vec<Template>, LlmError> {
    let mut templates = Vec::new();

    for entry in fs::read_dir(dir)? {
        let path = entry?.path();

        if path.extension().and_then(|ext| ext.to_str()) != Some(TEMPLATE_FILE_EXTENSION) {
            continue;
        }
        if path.file_name().and_then(|name| name.to_str()) == Some(SCHEMA_FILE_NAME) {
            continue;
        }

        match Template::load(&path) {
            Ok(template) => templates.push(template),
            Err(err) => eprintln!("myna-llm: skipping template {}: {err}", path.display()),
        }
    }

    templates.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(templates)
}
