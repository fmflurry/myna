/**
 * Identifies the ONE (template, language) pair currently generating, if any.
 * Replaces a bare boolean so the UI can scope the "generating" state to the
 * matching summary tab instead of showing the same loader on every tab —
 * see `MeetingDetailPaneComponent`'s `isGeneratingActiveTab`.
 */
export interface SummarizingKey {
  readonly template: string;
  readonly language: string;
}
