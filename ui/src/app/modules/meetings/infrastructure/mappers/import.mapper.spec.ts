import { toMeetingId } from '../../core/models/meeting.model';
import { mapImportProgressDtoToDomain } from './import.mapper';

describe('mapImportProgressDtoToDomain', () => {
  it('maps a converting-phase payload', () => {
    const progress = mapImportProgressDtoToDomain({
      meetingId: 'm-1',
      phase: 'converting',
      processedSec: 0,
      totalSec: 120,
    });

    expect(progress).toEqual({
      meetingId: toMeetingId('m-1'),
      phase: 'converting',
      processedSec: 0,
      totalSec: 120,
    });
  });

  it('maps a transcribing-phase payload', () => {
    const progress = mapImportProgressDtoToDomain({
      meetingId: 'm-2',
      phase: 'transcribing',
      processedSec: 45,
      totalSec: 120,
    });

    expect(progress).toEqual({
      meetingId: toMeetingId('m-2'),
      phase: 'transcribing',
      processedSec: 45,
      totalSec: 120,
    });
  });

  it('maps a done-phase payload', () => {
    const progress = mapImportProgressDtoToDomain({
      meetingId: 'm-3',
      phase: 'done',
      processedSec: 120,
      totalSec: 120,
    });

    expect(progress).toEqual({
      meetingId: toMeetingId('m-3'),
      phase: 'done',
      processedSec: 120,
      totalSec: 120,
    });
  });
});
