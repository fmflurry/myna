export interface ModelSlot {
  readonly present: boolean;
  readonly path?: string;
  readonly expectedFiles: readonly string[];
}

export interface ModelsStatus {
  readonly parakeet: ModelSlot;
  readonly qwen: ModelSlot;
  readonly silero: ModelSlot;
  readonly allPresent: boolean;
}
