import type { Observable } from 'rxjs';

import type { MeetingId } from '../models/meeting.model';
import type { SummaryLanguage } from '../models/summary-language.model';
import type { Summary } from '../models/summary.model';
import type { SummaryInstructionsDraft } from '../models/summary-instructions.model';
import type { SummaryTemplate } from '../models/summary-template.model';

export interface SummaryToken {
  readonly meetingId: MeetingId;
  readonly template: string;
  readonly token: string;
}

/**
 * Maps onto the frozen Rust commands summarize_meeting, cancel_summarization,
 * list_summary_languages, and get_summary, plus the summary://token and
 * summary://done events.
 */
export abstract class SummarizerPort {
  /**
   * `language` is optional here purely so existing call sites that don't
   * care about it keep compiling — real callers always resolve a concrete
   * code (defaulting to `en`) before calling. Omitted or unknown ⇒ the
   * Rust server falls back to `en` itself.
   *
   * `instructions` is the caller's per-request focus draft; `undefined`
   * means "no explicit choice" and lets the Rust side apply the persisted
   * general guidelines by default.
   */
  abstract summarize(
    id: MeetingId,
    template: SummaryTemplate,
    language?: string,
    instructions?: SummaryInstructionsDraft,
  ): Promise<Summary>;
  abstract listLanguages(): Promise<readonly SummaryLanguage[]>;
  abstract tokens(): Observable<SummaryToken>;
  abstract done(): Observable<Summary>;
  abstract cancel(): Promise<void>;
  /**
   * Reads back a persisted summary's full content by (meeting, template,
   * language). `null` is a normal, non-error result meaning no summary was
   * ever saved for that exact pair — never thrown as an error.
   */
  abstract getSummary(id: MeetingId, template: string, language: string): Promise<Summary | null>;
  /**
   * Persists an edited summary's markdown for the (meeting, template,
   * language) triple and resolves the saved summary. Write belongs here —
   * alongside `getSummary` — not on `MeetingRepositoryPort`.
   */
  abstract editSummary(id: MeetingId, template: string, language: string, markdown: string): Promise<Summary>;
  /**
   * Deletes the persisted summary for the (meeting, template, language)
   * triple. Resolves `void` on success; rejects (backend `NotFound`) when
   * no summary was ever saved for that exact triple.
   */
  abstract deleteSummary(id: MeetingId, template: string, language: string): Promise<void>;
  /**
   * Reads the persisted general summary guidelines (the free-text block the
   * user authors once and every generation can include). Empty string means
   * "none set".
   */
  abstract getGuidelines(): Promise<string>;
  /**
   * Persists the general summary guidelines, replacing any previous text.
   * Empty string clears them.
   */
  abstract setGuidelines(text: string): Promise<void>;
}
