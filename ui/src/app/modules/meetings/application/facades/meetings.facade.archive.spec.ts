import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
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

describe('MeetingsFacade archiving', () => {
  let facade: MeetingsFacade;
  let repository: InMemoryMeetingRepositoryFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideMeetings(), ...FAKE_PORT_OVERRIDES],
    });
    facade = TestBed.inject(MeetingsFacade);
    repository = TestBed.inject(MeetingRepositoryPort) as InMemoryMeetingRepositoryFake;
  });

  it('archives a meeting, updating both the meetings list and the selected meeting', async () => {
    const meeting = {
      id: toMeetingId('m-1'),
      title: 'Standup',
      createdAt: new Date(),
      durationSec: 0,
      summaries: [],
      archived: false,
      hasAudio: false, hasSystemTrack: false,
      droppedAudioChunks: 0,
    };
    repository.seed([meeting]);
    await facade.loadMeetings();
    await facade.openMeeting(meeting.id);

    await facade.setMeetingArchived(meeting.id, true);

    expect(facade.meetings()[0]?.archived).toBe(true);
    expect(facade.selectedMeeting()?.archived).toBe(true);
    expect(facade.error()).toBeUndefined();
  });

  it('surfaces an error and leaves archived unchanged when the repository rejects', async () => {
    const meeting = {
      id: toMeetingId('m-1'),
      title: 'Standup',
      createdAt: new Date(),
      durationSec: 0,
      summaries: [],
      archived: false,
      hasAudio: false, hasSystemTrack: false,
      droppedAudioChunks: 0,
    };
    repository.seed([meeting]);
    await facade.loadMeetings();
    await facade.openMeeting(meeting.id);

    await facade.setMeetingArchived(toMeetingId('missing'), true);

    expect(facade.error()?.code).toBe('NOT_FOUND');
    expect(facade.meetings()[0]?.archived).toBe(false);
    expect(facade.selectedMeeting()?.archived).toBe(false);
  });
});
