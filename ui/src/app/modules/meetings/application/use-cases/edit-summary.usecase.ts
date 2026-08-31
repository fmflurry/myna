import { Injectable, inject } from '@angular/core';

import type { MeetingId } from '../../core/models/meeting.model';
import type { Summary } from '../../core/models/summary.model';
import { SummarizerPort } from '../../core/ports/summarizer.port';

/** Maps onto the frozen Rust command edit_summary: persists an edited summary's markdown. */
@Injectable()
export class EditSummaryUseCase {
  private readonly summarizer = inject(SummarizerPort);

  async edit(id: MeetingId, template: string, language: string, markdown: string): Promise<Summary> {
    return this.summarizer.editSummary(id, template, language, markdown);
  }
}
