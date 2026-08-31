/**
 * Wire shapes for summary data crossing the Tauri IPC boundary. Both mirror
 * Rust structs with `#[serde(rename_all = "camelCase")]`; dates are RFC3339
 * strings.
 */

/** Mirrors the Rust `SummaryRefDto` — a pointer to a persisted summary. */
export interface SummaryRefDto {
  readonly template: string;
  readonly createdAt: string;
  readonly path: string;
  readonly language: string;
  /** Set true on every summary ref when the meeting is re-transcribed; cleared when that summary is regenerated. */
  readonly stale: boolean;
}

/** Mirrors the Rust `SummaryDto` — a summary's full generated content. */
export interface SummaryDto {
  readonly template: string;
  readonly markdown: string;
  readonly createdAt: string;
  readonly language: string;
}

/** Mirrors one entry of the Rust `list_summary_languages` result. */
export interface SummaryLanguageDto {
  readonly code: string;
  readonly label: string;
}
