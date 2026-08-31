export interface Summary {
  readonly template: string;
  readonly markdown: string;
  readonly createdAt: Date;
  /** Short language tag ('en', 'fr', ...) the summary content was generated in. */
  readonly language: string;
  /** True when the meeting has been re-transcribed since this summary was generated; cleared once the summary is regenerated. Always `false` for a freshly generated summary. */
  readonly stale: boolean;
}
