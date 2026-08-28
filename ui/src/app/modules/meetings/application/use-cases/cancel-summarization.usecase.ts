import { Injectable, inject } from '@angular/core';

import { SummarizerPort } from '../../core/ports/summarizer.port';

@Injectable()
export class CancelSummarizationUseCase {
  private readonly summarizer = inject(SummarizerPort);

  async cancel(): Promise<void> {
    await this.summarizer.cancel();
  }
}
