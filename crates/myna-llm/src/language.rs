//! Supported output languages for generated summaries.
//!
//! `myna-llm` owns this list — it is the single source of truth for which
//! languages a summary may be generated in. Callers must go through
//! [`resolve`] rather than trusting an arbitrary caller-supplied code, so an
//! unvalidated string never reaches a prompt.

/// A supported summary output language: a short BCP-47 code plus its
/// English display label.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SummaryLanguage {
    pub code: &'static str,
    pub label: &'static str,
}

/// Fallback language code used when none is requested or the requested code
/// is not recognized.
pub const DEFAULT_SUMMARY_LANGUAGE: &str = "en";

/// Curated list of languages Qwen2.5-7B-Instruct handles well.
pub const SUMMARY_LANGUAGES: [SummaryLanguage; 7] = [
    SummaryLanguage {
        code: "en",
        label: "English",
    },
    SummaryLanguage {
        code: "fr",
        label: "French",
    },
    SummaryLanguage {
        code: "es",
        label: "Spanish",
    },
    SummaryLanguage {
        code: "de",
        label: "German",
    },
    SummaryLanguage {
        code: "it",
        label: "Italian",
    },
    SummaryLanguage {
        code: "pt",
        label: "Portuguese",
    },
    SummaryLanguage {
        code: "nl",
        label: "Dutch",
    },
];

/// Looks up the English display label for `code`, if `code` is recognized.
pub fn label_for(code: &str) -> Option<&'static str> {
    SUMMARY_LANGUAGES
        .iter()
        .find(|language| language.code == code)
        .map(|language| language.label)
}

/// Resolves a caller-supplied language code to a known `(code, label)` pair,
/// falling back to [`DEFAULT_SUMMARY_LANGUAGE`] when `code` is `None` or not
/// recognized. The returned code/label always come from
/// [`SUMMARY_LANGUAGES`] — the caller's raw string is never echoed back or
/// interpolated into a prompt.
pub fn resolve(code: Option<&str>) -> (&'static str, &'static str) {
    code.and_then(|requested| {
        SUMMARY_LANGUAGES
            .iter()
            .find(|language| language.code == requested)
    })
    .or_else(|| {
        SUMMARY_LANGUAGES
            .iter()
            .find(|language| language.code == DEFAULT_SUMMARY_LANGUAGE)
    })
    .map(|language| (language.code, language.label))
    .expect("DEFAULT_SUMMARY_LANGUAGE must be present in SUMMARY_LANGUAGES")
}
