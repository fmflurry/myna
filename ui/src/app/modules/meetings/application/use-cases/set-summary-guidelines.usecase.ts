import { Injectable, inject } from '@angular/core';

import { SummarizerPort } from '../../core/ports/summarizer.port';

/** Persists the general summary guidelines server-side, replacing any previous text; empty string clears them. */
@Injectable()
export class SetSummaryGuidelinesUseCase {
  private readonly summarizer = inject(SummarizerPort);

  async set(text: string): Promise<void> {
    await this.summarizer.setGuidelines(text);
  }
}
