import { Injectable, inject } from '@angular/core';

import type { MeetingId } from '../../core/models/meeting.model';
import type { Summary } from '../../core/models/summary.model';
import type { SummaryInstructionsDraft } from '../../core/models/summary-instructions.model';
import type { SummaryTemplate } from '../../core/models/summary-template.model';
import { SummarizerPort } from '../../core/ports/summarizer.port';

@Injectable()
export class SummarizeMeetingUseCase {
  private readonly summarizer = inject(SummarizerPort);

  async summarize(id: MeetingId, template: SummaryTemplate, language?: string, instructions?: SummaryInstructionsDraft): Promise<Summary> {
    return this.summarizer.summarize(id, template, language, instructions);
  }
}
