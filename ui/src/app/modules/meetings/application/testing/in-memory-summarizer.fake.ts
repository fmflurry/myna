import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

import type { MeetingId } from '../../core/models/meeting.model';
import { MeetingsError } from '../../core/models/recording-state.model';
import { DEFAULT_SUMMARY_LANGUAGE_CODE, type SummaryLanguage } from '../../core/models/summary-language.model';
import type { Summary } from '../../core/models/summary.model';
import type { SummaryInstructionsDraft } from '../../core/models/summary-instructions.model';
import type { SummaryTemplate } from '../../core/models/summary-template.model';
import { SummarizerPort, type SummaryToken } from '../../core/ports/summarizer.port';

const DEFAULT_LANGUAGES: readonly SummaryLanguage[] = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'French' },
];

/** In-memory SummarizerPort implementation for specs and the placeholder providers. */
@Injectable()
export class InMemorySummarizerFake extends SummarizerPort {
  private readonly tokenSubject = new Subject<SummaryToken>();
  private readonly doneSubject = new Subject<Summary>();
  private languages: readonly SummaryLanguage[] = DEFAULT_LANGUAGES;
  private readonly savedSummaries = new Map<string, Summary>();
  private guidelines = '';

  /**
   * The instructions draft passed to the most recent `summarize()` call —
   * `undefined` when that call omitted it. Exposed for assertions.
   */
  lastInstructions: SummaryInstructionsDraft | undefined;

  private savedSummaryKey(id: MeetingId, template: string, language: string): string {
    return `${id}::${template}::${language}`;
  }

  override async summarize(
    id: MeetingId,
    template: SummaryTemplate,
    language?: string,
    instructions?: SummaryInstructionsDraft,
  ): Promise<Summary> {
    this.lastInstructions = instructions;
    const summary: Summary = {
      template: template.name,
      markdown: `# ${template.name}\n\nSummary body.`,
      createdAt: new Date(),
      language: language ?? DEFAULT_SUMMARY_LANGUAGE_CODE,
      stale: false,
    };
    this.savedSummaries.set(this.savedSummaryKey(id, summary.template, summary.language), summary);
    this.doneSubject.next(summary);
    return summary;
  }

  override async listLanguages(): Promise<readonly SummaryLanguage[]> {
    return this.languages;
  }

  override tokens(): Observable<SummaryToken> {
    return this.tokenSubject.asObservable();
  }

  override done(): Observable<Summary> {
    return this.doneSubject.asObservable();
  }

  override async cancel(): Promise<void> {
    return Promise.resolve();
  }

  override async getSummary(id: MeetingId, template: string, language: string): Promise<Summary | null> {
    return this.savedSummaries.get(this.savedSummaryKey(id, template, language)) ?? null;
  }

  override async editSummary(id: MeetingId, template: string, language: string, markdown: string): Promise<Summary> {
    const existing = await this.getSummary(id, template, language);
    const edited: Summary = {
      template,
      markdown,
      createdAt: existing?.createdAt ?? new Date(),
      language,
      stale: false,
    };
    this.savedSummaries.set(this.savedSummaryKey(id, template, language), edited);
    return edited;
  }

  override async deleteSummary(id: MeetingId, template: string, language: string): Promise<void> {
    const key = this.savedSummaryKey(id, template, language);
    if (!this.savedSummaries.has(key)) {
      throw new MeetingsError('NOT_FOUND', `No summary for meeting ${id} (${template}/${language}).`);
    }
    this.savedSummaries.delete(key);
  }

  override async getGuidelines(): Promise<string> {
    return this.guidelines;
  }

  override async setGuidelines(text: string): Promise<void> {
    this.guidelines = text;
  }

  /** Test helper: push a synthetic streamed summary token. */
  emitToken(token: SummaryToken): void {
    this.tokenSubject.next(token);
  }

  /** Test helper: replace the in-memory summary language list. */
  seedLanguages(languages: readonly SummaryLanguage[]): void {
    this.languages = languages;
  }

  /** Test helper: seed a persisted summary so getSummary() resolves it without a prior summarize() call. */
  seedSummary(id: MeetingId, summary: Summary): void {
    this.savedSummaries.set(this.savedSummaryKey(id, summary.template, summary.language), summary);
  }
}
