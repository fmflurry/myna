import { Injectable, inject } from '@angular/core';

import type { MeetingId } from '../../core/models/meeting.model';
import type { Summary } from '../../core/models/summary.model';
import { SummarizerPort } from '../../core/ports/summarizer.port';

/** Maps onto the frozen Rust command get_summary. `null` means no saved summary exists for that pair. */
@Injectable()
export class GetSummaryUseCase {
  private readonly summarizer = inject(SummarizerPort);

  async get(id: MeetingId, template: string, language: string): Promise<Summary | null> {
    return this.summarizer.getSummary(id, template, language);
  }
}
