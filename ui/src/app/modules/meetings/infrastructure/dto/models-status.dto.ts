/** Mirrors the Rust `ModelSlot` (`#[serde(rename_all = "camelCase")]`). */
export interface ModelSlotDto {
  readonly present: boolean;
  readonly path: string;
  readonly expectedFiles: readonly string[];
}

/** Mirrors the Rust `ModelsStatusDto` (`#[serde(rename_all = "camelCase")]`). */
export interface ModelsStatusDto {
  readonly parakeet: ModelSlotDto;
  readonly qwen: ModelSlotDto;
  readonly silero: ModelSlotDto;
  readonly allPresent: boolean;
}
