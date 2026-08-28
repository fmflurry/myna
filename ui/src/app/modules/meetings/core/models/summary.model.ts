export interface Summary {
  readonly template: string;
  readonly markdown: string;
  readonly createdAt: Date;
  /** Short language tag ('en', 'fr', ...) the summary content was generated in. */
  readonly language: string;
}
