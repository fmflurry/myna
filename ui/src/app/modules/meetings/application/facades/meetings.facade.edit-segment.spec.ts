import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { toMeetingId } from '../../core/models/meeting.model';
import { MeetingsError } from '../../core/models/recording-state.model';
import { AppInfoPort } from '../../core/ports/app-info.port';
import { FileDialogPort } from '../../core/ports/file-dialog.port';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';
import { ModelsStatusPort } from '../../core/ports/models-status.port';
import { PreferencesPort } from '../../core/ports/preferences.port';
import { RecorderPort } from '../../core/ports/recorder.port';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { TemplateRepositoryPort } from '../../core/ports/template-repository.port';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import { provideMeetings } from '../../meetings.providers';
import { InMemoryAppInfoFake } from '../testing/in-memory-app-info.fake';
import { InMemoryFileDialogFake } from '../testing/in-memory-file-dialog.fake';
import { InMemoryMeetingRepositoryFake } from '../testing/in-memory-meeting-repository.fake';
import { InMemoryModelsStatusFake } from '../testing/in-memory-models-status.fake';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { InMemoryTemplateRepositoryFake } from '../testing/in-memory-template-repository.fake';
import { InMemoryTranscriberFake } from '../testing/in-memory-transcriber.fake';
import { MeetingsFacade } from './meetings.facade';

/**
 * `provideMeetings()` binds the real Tauri adapters (correct for the
 * shipped app), so every fake port used below is layered on top via
 * explicit overrides — this spec exercises the facade against fakes,
 * not against a live Tauri runtime.
 */
const FAKE_PORT_OVERRIDES = [
  { provide: MeetingRepositoryPort, useClass: InMemoryMeetingRepositoryFake },
  { provide: RecorderPort, useClass: InMemoryRecorderFake },
  { provide: SummarizerPort, useClass: InMemorySummarizerFake },
  { provide: TranscriberPort, useClass: InMemoryTranscriberFake },
  { provide: TemplateRepositoryPort, useClass: InMemoryTemplateRepositoryFake },
  { provide: ModelsStatusPort, useClass: InMemoryModelsStatusFake },
  { provide: FileDialogPort, useClass: InMemoryFileDialogFake },
  { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
  { provide: AppInfoPort, useClass: InMemoryAppInfoFake },
];

describe('MeetingsFacade editTranscriptSegment', () => {
  let facade: MeetingsFacade;
  let repository: InMemoryMeetingRepositoryFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideMeetings(), ...FAKE_PORT_OVERRIDES],
    });
    facade = TestBed.inject(MeetingsFacade);
    repository = TestBed.inject(MeetingRepositoryPort) as InMemoryMeetingRepositoryFake;
  });

  const seededMeeting = {
    id: toMeetingId('m-1'),
    title: 'Standup',
    createdAt: new Date(),
    durationSec: 0,
    summaries: [],
    archived: false,
    hasAudio: false,
    transcript: {
      segments: [
        { startSec: 0, endSec: 5, text: 'first' },
        { startSec: 5, endSec: 10, text: 'second' },
      ],
    },
  };

  it('replaces the meeting in meetings() and clears the error', async () => {
    repository.seed([seededMeeting]);
    await facade.loadMeetings();

    await facade.editTranscriptSegment(seededMeeting.id, 1, 'corrected');

    expect(facade.meetings()[0]?.transcript?.segments[1]?.text).toBe('corrected');
    expect(facade.error()).toBeUndefined();
  });

  it('updates selectedMeeting().transcript when editing the selected meeting', async () => {
    repository.seed([seededMeeting]);
    await facade.loadMeetings();
    await facade.openMeeting(seededMeeting.id);

    await facade.editTranscriptSegment(seededMeeting.id, 1, 'corrected');

    expect(facade.selectedMeeting()?.transcript?.segments[1]?.text).toBe('corrected');
  });

  it('leaves meetings() and selectedMeeting() unchanged and sets error BUSY when the repository rejects', async () => {
    repository.seed([seededMeeting]);
    await facade.loadMeetings();
    await facade.openMeeting(seededMeeting.id);
    vi.spyOn(repository, 'editTranscriptSegment').mockRejectedValueOnce(
      new MeetingsError('BUSY', 'Meeting is recording.'),
    );

    await facade.editTranscriptSegment(seededMeeting.id, 1, 'corrected');

    expect(facade.error()?.code).toBe('BUSY');
    expect(facade.meetings()[0]?.transcript?.segments[1]?.text).toBe('second');
    expect(facade.selectedMeeting()?.transcript?.segments[1]?.text).toBe('second');
  });
});
