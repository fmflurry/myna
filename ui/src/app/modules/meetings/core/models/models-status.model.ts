export interface ModelSlot {
  readonly present: boolean;
  readonly path?: string;
  readonly expectedFiles: readonly string[];
}

export interface ModelsStatus {
  readonly parakeet: ModelSlot;
  readonly qwen: ModelSlot;
  readonly silero: ModelSlot;
  /**
   * Presence of the speaker-diarization models (pyannote-3.0 segmentation +
   * NeMo TitaNet embedding). Deliberately EXCLUDED from `allPresent` — a
   * manual-only, optional feature (`./scripts/download-models.sh --only
   * diarization`), never part of the default download. Optional so DTO/
   * fixture literals predating this field keep type-checking.
   */
  readonly diarization?: ModelSlot;
  readonly allPresent: boolean;
}
