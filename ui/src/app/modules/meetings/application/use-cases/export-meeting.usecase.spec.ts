import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';
import { InMemoryMeetingRepositoryFake } from '../testing/in-memory-meeting-repository.fake';
import { ExportMeetingUseCase } from './export-meeting.usecase';

describe('ExportMeetingUseCase', () => {
  let useCase: ExportMeetingUseCase;
  let repository: InMemoryMeetingRepositoryFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ExportMeetingUseCase,
        InMemoryMeetingRepositoryFake,
        { provide: MeetingRepositoryPort, useExisting: InMemoryMeetingRepositoryFake },
      ],
    });
    useCase = TestBed.inject(ExportMeetingUseCase);
    repository = TestBed.inject(InMemoryMeetingRepositoryFake);
  });

  it('delegates to the meeting repository export with the given format and destination', async () => {
    repository.seed([
      { id: toMeetingId('m-1'), title: 'Standup', createdAt: new Date(), durationSec: 0, summaries: [] },
    ]);

    const result = await useCase.export(toMeetingId('m-1'), 'markdown', '/tmp/standup.md');

    expect(result).toBeUndefined();
  });
});
