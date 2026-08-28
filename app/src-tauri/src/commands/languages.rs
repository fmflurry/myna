//! Summary output language listing.

use myna_llm::SUMMARY_LANGUAGES;

use crate::dto::SummaryLanguageDto;

/// Lists the languages available for generated summary output.
///
/// `myna_llm::SUMMARY_LANGUAGES` is the single source of truth — the UI
/// renders whatever this returns rather than hardcoding its own list.
#[tauri::command]
pub fn list_summary_languages() -> Vec<SummaryLanguageDto> {
    SUMMARY_LANGUAGES
        .iter()
        .map(|language| SummaryLanguageDto {
            code: language.code.to_string(),
            label: language.label.to_string(),
        })
        .collect()
}
