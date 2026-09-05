/**
 * UI-side draft of per-request summary instructions, as authored by the user
 * before a summarization run. `text` is the free-text focus for this one
 * generation; `includeGeneral` decides whether the persisted general
 * guidelines join the prompt. The adapter maps this onto the Rust
 * `SummarizeInstructionsDto` wire shape (`{ specific, includeGeneral }`);
 * trimming, capping, and empty-collapse happen Rust-side, not here.
 */
export interface SummaryInstructionsDraft {
  readonly text: string;
  readonly includeGeneral: boolean;
}
