import { Injectable, inject } from '@angular/core';

import type { SummaryLanguage } from '../../core/models/summary-language.model';
import { SummarizerPort } from '../../core/ports/summarizer.port';

/** Maps onto the frozen Rust command list_summary_languages. */
@Injectable()
export class ListSummaryLanguagesUseCase {
  private readonly summarizer = inject(SummarizerPort);

  async list(): Promise<readonly SummaryLanguage[]> {
    return this.summarizer.listLanguages();
  }
}
