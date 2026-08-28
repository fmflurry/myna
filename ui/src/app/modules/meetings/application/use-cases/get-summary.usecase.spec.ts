import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { GetSummaryUseCase } from './get-summary.usecase';

describe('GetSummaryUseCase', () => {
  let useCase: GetSummaryUseCase;
  let summarizer: InMemorySummarizerFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [GetSummaryUseCase, { provide: SummarizerPort, useClass: InMemorySummarizerFake }],
    });
    useCase = TestBed.inject(GetSummaryUseCase);
    summarizer = TestBed.inject(SummarizerPort) as InMemorySummarizerFake;
  });

  it('resolves the persisted summary for the given meeting, template and language', async () => {
    const meetingId = toMeetingId('m-1');
    summarizer.seedSummary(meetingId, {
      template: 'key-points',
      markdown: '# Key points',
      createdAt: new Date('2026-01-15T10:00:00Z'),
      language: 'en',
    });

    const summary = await useCase.get(meetingId, 'key-points', 'en');

    expect(summary?.markdown).toBe('# Key points');
  });

  it('resolves null when no summary was ever persisted for that pair', async () => {
    const summary = await useCase.get(toMeetingId('m-1'), 'key-points', 'en');

    expect(summary).toBeNull();
  });
});
