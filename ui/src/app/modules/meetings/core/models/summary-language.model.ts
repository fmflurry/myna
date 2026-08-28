/**
 * A summary output language offered by the Rust core. `code` is a short
 * tag ('en', 'fr', ...) sent back to `summarize_meeting`; `label` is an
 * English display name. The Rust core owns the authoritative list — this
 * module never hardcodes a second copy of it.
 */
export interface SummaryLanguage {
  readonly code: string;
  readonly label: string;
}

/**
 * Fallback language code used until a real preference has been loaded, and
 * whenever nothing has been stored yet. Mirrors the Rust server's own
 * fallback for an omitted or unknown `summarize_meeting` language arg.
 */
export const DEFAULT_SUMMARY_LANGUAGE_CODE = 'en';
