//! User-authored instructions injected ahead of a template's prompt text.
//!
//! Two independent channels reach a summary request: `general` guidelines
//! (long-lived, e.g. "always list open questions") and `specific`
//! instructions for one request (e.g. "focus on the budget discussion").
//! The combine/ignore decision happens upstream — a general guideline the
//! user opted out of simply arrives as `None` here, never as an
//! "ignored" marker.
//!
//! [`SummaryInstructions::compose`] is a pure function producing the block
//! prepended to the rendered template text. Instruction text is **never**
//! placeholder-substituted: braces inside it (e.g. `{transcript}`) are
//! inert user prose, and template validation only scans the template's own
//! `prompt`, so such text can neither trigger substitution nor be rejected
//! as an unknown placeholder.

use serde::{Deserialize, Serialize};

/// Maximum length, in Unicode scalar values (`char`s — not bytes, so
/// non-ASCII instructions get the same budget), of either instruction
/// field after trimming. Longer text is truncated at this many scalars
/// with a `…` appended. The cap keeps user prose from crowding out the
/// transcript in the model's context window.
pub const MAX_INSTRUCTION_CHARS: usize = 4000;

const GENERAL_HEADER: &str = "General guidelines for this summary:";
const SPECIFIC_HEADER: &str = concat!(
    "Instructions for this specific request (they take precedence over ",
    "the general guidelines above where they conflict):"
);

/// User-authored general and per-request instructions for one summary.
///
/// serde-friendly because it crosses the Tauri IPC boundary in a later
/// phase; both fields default to `None` so partial payloads deserialize.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SummaryInstructions {
    #[serde(default)]
    pub general: Option<String>,
    #[serde(default)]
    pub specific: Option<String>,
}

impl SummaryInstructions {
    /// Build instructions from the two optional fields.
    pub fn new(general: Option<String>, specific: Option<String>) -> Self {
        Self { general, specific }
    }

    /// Compose the instruction block prepended to a rendered template, or
    /// `None` when there is nothing to inject (in which case the final
    /// prompt stays byte-identical to a template-only render).
    ///
    /// Layout: each non-empty (after trim + cap) field becomes a header
    /// line followed by its text; blocks are separated by a blank line;
    /// the block ends with a `---` separator line plus a blank line, after
    /// which the template text follows — keeping the template's trailing
    /// generation cue (e.g. "Key Points:") the final line of the prompt.
    pub fn compose(&self) -> Option<String> {
        let general = self.general.as_deref().and_then(capped);
        let specific = self.specific.as_deref().and_then(capped);

        let mut blocks = Vec::with_capacity(2);
        if let Some(text) = general.as_deref() {
            blocks.push(format!("{GENERAL_HEADER}\n{text}"));
        }
        if let Some(text) = specific.as_deref() {
            blocks.push(format!("{SPECIFIC_HEADER}\n{text}"));
        }
        if blocks.is_empty() {
            return None;
        }

        Some(format!("{}\n\n---\n\n", blocks.join("\n\n")))
    }
}

/// Trim `text` and truncate it to [`MAX_INSTRUCTION_CHARS`] Unicode
/// scalars (appending `…` when truncation happened). `None` when nothing
/// survives trimming.
fn capped(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() <= MAX_INSTRUCTION_CHARS {
        return Some(trimmed.to_string());
    }
    let kept: String = trimmed.chars().take(MAX_INSTRUCTION_CHARS).collect();
    Some(format!("{kept}\u{2026}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instructions(general: Option<&str>, specific: Option<&str>) -> SummaryInstructions {
        SummaryInstructions::new(general.map(str::to_string), specific.map(str::to_string))
    }

    #[test]
    fn compose_returns_none_when_both_fields_are_absent() {
        assert_eq!(instructions(None, None).compose(), None);
        assert_eq!(SummaryInstructions::default().compose(), None);
    }

    #[test]
    fn compose_returns_none_when_both_fields_are_whitespace_only() {
        assert_eq!(instructions(Some("   \n\t "), Some("  ")).compose(), None);
    }

    #[test]
    fn compose_renders_general_only_block() {
        let composed = instructions(Some("Always list open questions."), None)
            .compose()
            .expect("general-only instructions should compose");
        assert_eq!(
            composed,
            "General guidelines for this summary:\nAlways list open questions.\n\n---\n\n"
        );
    }

    #[test]
    fn compose_renders_specific_only_block() {
        let composed = instructions(None, Some("Focus on the budget discussion."))
            .compose()
            .expect("specific-only instructions should compose");
        assert_eq!(
            composed,
            "Instructions for this specific request (they take precedence over \
             the general guidelines above where they conflict):\n\
             Focus on the budget discussion.\n\n---\n\n"
        );
    }

    #[test]
    fn compose_renders_both_blocks_general_first_separated_by_blank_line() {
        let composed = instructions(Some("Be concise."), Some("Focus on the budget discussion."))
            .compose()
            .expect("both fields should compose");
        assert_eq!(
            composed,
            "General guidelines for this summary:\nBe concise.\n\n\
             Instructions for this specific request (they take precedence over \
             the general guidelines above where they conflict):\n\
             Focus on the budget discussion.\n\n---\n\n"
        );
    }

    #[test]
    fn compose_trims_each_part() {
        let composed = instructions(Some("\n  Be concise.  \n"), Some("   Ship it   "))
            .compose()
            .expect("padded instructions should compose");
        assert!(composed.contains("General guidelines for this summary:\nBe concise.\n\n"));
        assert!(composed.ends_with("Ship it\n\n---\n\n"));
    }

    #[test]
    fn compose_truncates_each_field_by_unicode_scalars_not_bytes() {
        // 4,001 'é' characters are 8,002 bytes but 4,001 scalars: a
        // byte-based cap would halve the budget. The kept prefix must be
        // exactly MAX_INSTRUCTION_CHARS scalars plus the ellipsis.
        let long = "é".repeat(MAX_INSTRUCTION_CHARS + 1);
        let composed = instructions(Some(&long), Some(&long))
            .compose()
            .expect("over-cap instructions should compose");
        let expected_kept = "é".repeat(MAX_INSTRUCTION_CHARS);
        assert!(composed.contains(&format!("{expected_kept}\u{2026}")));
        assert!(
            !composed.contains(&"é".repeat(MAX_INSTRUCTION_CHARS + 1)),
            "instruction text must be capped at {MAX_INSTRUCTION_CHARS} scalars"
        );
        // Both fields are capped independently.
        let general_count = composed.matches('é').count();
        assert_eq!(general_count, MAX_INSTRUCTION_CHARS * 2);
    }

    #[test]
    fn compose_leaves_placeholder_like_braces_verbatim() {
        // Braces in user prose must survive compose() untouched — no
        // substitution happens at this layer (render() only substitutes
        // the template's own prompt).
        let composed = instructions(Some("Mention {transcript} and {unknown} literally."), None)
            .compose()
            .expect("instructions with braces should compose");
        assert!(composed.contains("Mention {transcript} and {unknown} literally."));
    }

    #[test]
    fn instructions_round_trip_through_json_with_defaults() {
        let json = serde_json::to_string(&instructions(Some("a"), Some("b")))
            .expect("instructions should serialize");
        let round_tripped: SummaryInstructions =
            serde_json::from_str(&json).expect("instructions should deserialize");
        assert_eq!(round_tripped, instructions(Some("a"), Some("b")));

        // Partial / empty payloads deserialize with the missing side as None.
        let partial: SummaryInstructions =
            serde_json::from_str(r#"{"general":"g"}"#).expect("partial payload should load");
        assert_eq!(partial.general.as_deref(), Some("g"));
        assert_eq!(partial.specific, None);
        let empty: SummaryInstructions =
            serde_json::from_str("{}").expect("empty payload should load");
        assert_eq!(empty, SummaryInstructions::default());
    }
}
