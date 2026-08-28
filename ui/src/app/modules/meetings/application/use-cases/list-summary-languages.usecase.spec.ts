import { TestBed } from '@angular/core/testing';

import { SummarizerPort } from '../../core/ports/summarizer.port';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { ListSummaryLanguagesUseCase } from './list-summary-languages.usecase';

describe('ListSummaryLanguagesUseCase', () => {
  let useCase: ListSummaryLanguagesUseCase;
  let summarizer: InMemorySummarizerFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ListSummaryLanguagesUseCase,
        InMemorySummarizerFake,
        { provide: SummarizerPort, useExisting: InMemorySummarizerFake },
      ],
    });
    useCase = TestBed.inject(ListSummaryLanguagesUseCase);
    summarizer = TestBed.inject(InMemorySummarizerFake);
  });

  it('returns the languages exposed by the port, not a hardcoded list', async () => {
    summarizer.seedLanguages([{ code: 'de', label: 'German' }]);

    const languages = await useCase.list();

    expect(languages).toEqual([{ code: 'de', label: 'German' }]);
  });

  it('returns the default in-memory languages when nothing is seeded', async () => {
    const languages = await useCase.list();

    expect(languages.length).toBeGreaterThan(0);
  });
});
