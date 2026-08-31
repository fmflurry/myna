import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { EditSummaryUseCase } from './edit-summary.usecase';

describe('EditSummaryUseCase', () => {
  let useCase: EditSummaryUseCase;
  let summarizer: InMemorySummarizerFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [EditSummaryUseCase, { provide: SummarizerPort, useClass: InMemorySummarizerFake }],
    });
    useCase = TestBed.inject(EditSummaryUseCase);
    summarizer = TestBed.inject(SummarizerPort) as InMemorySummarizerFake;
  });

  it('delegates to SummarizerPort.editSummary and resolves the saved summary', async () => {
    const meetingId = toMeetingId('m-1');
    summarizer.seedSummary(meetingId, {
      template: 'key-points',
      markdown: '# Key points',
      createdAt: new Date('2026-01-15T10:00:00Z'),
      language: 'en',
      stale: false,
    });

    const summary = await useCase.edit(meetingId, 'key-points', 'en', '# Edited');

    expect(summary.markdown).toBe('# Edited');
    expect(summary.template).toBe('key-points');
    expect(summary.language).toBe('en');
    const reread = await summarizer.getSummary(meetingId, 'key-points', 'en');
    expect(reread?.markdown).toBe('# Edited');
  });
});
