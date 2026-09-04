import { Injectable, inject } from '@angular/core';

import { SummarizerPort } from '../../core/ports/summarizer.port';

/** Reads the persisted general summary guidelines; the server is the source of truth (empty string = none set). */
@Injectable()
export class GetSummaryGuidelinesUseCase {
  private readonly summarizer = inject(SummarizerPort);

  async get(): Promise<string> {
    return this.summarizer.getGuidelines();
  }
}
