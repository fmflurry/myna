export interface SummarySection {
  readonly key: string;
  readonly title: string;
}

export interface SummaryTemplate {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly sectionSchema?: readonly SummarySection[];
  /** Short display name for the tab strip, e.g. `Notes` — max 24 chars. Never the tab label alone; pair with {@link emoji}. */
  readonly label?: string;
  /** Single emoji prefix for the tab strip, e.g. `📝`. */
  readonly emoji?: string;
}
