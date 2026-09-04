import { Injectable, inject } from '@angular/core';

import type { MeetingId } from '../../core/models/meeting.model';
import { SummarizerPort } from '../../core/ports/summarizer.port';

/** Maps onto the frozen Rust command delete_summary: removes a persisted summary. */
@Injectable()
export class DeleteSummaryUseCase {
  private readonly summarizer = inject(SummarizerPort);

  async delete(id: MeetingId, template: string, language: string): Promise<void> {
    return this.summarizer.deleteSummary(id, template, language);
  }
}
