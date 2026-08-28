import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';
import { InMemoryMeetingRepositoryFake } from '../testing/in-memory-meeting-repository.fake';
import { EditTranscriptSegmentUseCase } from './edit-transcript-segment.usecase';

describe('EditTranscriptSegmentUseCase', () => {
  let useCase: EditTranscriptSegmentUseCase;
  let repository: InMemoryMeetingRepositoryFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        EditTranscriptSegmentUseCase,
        InMemoryMeetingRepositoryFake,
        { provide: MeetingRepositoryPort, useExisting: InMemoryMeetingRepositoryFake },
      ],
    });
    useCase = TestBed.inject(EditTranscriptSegmentUseCase);
    repository = TestBed.inject(InMemoryMeetingRepositoryFake);
  });

  it('edits one transcript segment, leaving the other untouched', async () => {
    const id = toMeetingId('m-9');
    repository.seed([
      {
        id,
        title: 'Planning',
        createdAt: new Date(),
        durationSec: 30,
        summaries: [],
        archived: false,
        hasAudio: false,
        transcript: {
          segments: [
            { startSec: 0, endSec: 5, text: 'first' },
            { startSec: 5, endSec: 10, text: 'seconde' },
          ],
        },
      },
    ]);

    const edited = await useCase.edit(id, 1, ' corrected ');

    expect(edited.transcript?.segments[1]?.text).toBe('corrected');
    expect(edited.transcript?.segments[0]?.text).toBe('first');
  });

  it('rejects an unknown meeting id', async () => {
    let caught: unknown;
    try {
      await useCase.edit(toMeetingId('missing'), 0, 'text');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
  });
});
