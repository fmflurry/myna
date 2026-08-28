import { TestBed } from '@angular/core/testing';

import { SummarizerPort } from '../../core/ports/summarizer.port';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { CancelSummarizationUseCase } from './cancel-summarization.usecase';

describe('CancelSummarizationUseCase', () => {
  let useCase: CancelSummarizationUseCase;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        CancelSummarizationUseCase,
        InMemorySummarizerFake,
        { provide: SummarizerPort, useExisting: InMemorySummarizerFake },
      ],
    });
    useCase = TestBed.inject(CancelSummarizationUseCase);
  });

  it('delegates to the summarizer port without throwing', async () => {
    const result = await useCase.cancel();

    expect(result).toBeUndefined();
  });
});
