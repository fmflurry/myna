import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { SummarizeMeetingUseCase } from './summarize-meeting.usecase';

describe('SummarizeMeetingUseCase', () => {
  let useCase: SummarizeMeetingUseCase;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [SummarizeMeetingUseCase, { provide: SummarizerPort, useClass: InMemorySummarizerFake }],
    });
    useCase = TestBed.inject(SummarizeMeetingUseCase);
  });

  it('returns a summary generated from the given template', async () => {
    const summary = await useCase.summarize(toMeetingId('m-1'), {
      name: 'key-points',
      description: 'Key points',
      prompt: 'Summarize the key points.',
    });

    expect(summary.template).toBe('key-points');
    expect(summary.markdown.length).toBeGreaterThan(0);
  });

  it('produces a summary with a Date createdAt timestamp', async () => {
    const template = { name: 'decisions', description: 'Decisions', prompt: 'List decisions.' };

    const summary = await useCase.summarize(toMeetingId('m-2'), template);

    expect(summary.createdAt).toBeInstanceOf(Date);
  });
});
