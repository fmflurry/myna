import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import { AppInfoPort } from '../../core/ports/app-info.port';
import { AudioImportPort } from '../../core/ports/audio-import.port';
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
import { InMemoryAudioImportFake } from '../testing/in-memory-audio-import.fake';
import { InMemoryFileDialogFake } from '../testing/in-memory-file-dialog.fake';
import { InMemoryMeetingRepositoryFake } from '../testing/in-memory-meeting-repository.fake';
import { InMemoryModelsStatusFake } from '../testing/in-memory-models-status.fake';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { InMemoryTemplateRepositoryFake } from '../testing/in-memory-template-repository.fake';
import { InMemoryTranscriberFake } from '../testing/in-memory-transcriber.fake';
import { transcriptSegment } from '../testing/transcript-segment.factory';
import { SetSegmentSpeakerUseCase } from '../use-cases/set-segment-speaker.usecase';
import { MeetingsStore } from '../stores/meetings.store';
import { MeetingsFacade } from './meetings.facade';
import { runSetSegmentSpeakerGroupWithHistory, runUndoLastSpeakerOp } from './meetings-facade-speaker-history.support';
import { RenameSpeakerUseCase } from '../use-cases/rename-speaker.usecase';
import { RemoveSpeakerUseCase } from '../use-cases/remove-speaker.usecase';

/**
 * `provideMeetings()` binds the real Tauri adapters (correct for the shipped
 * app), so every fake port used below is layered on top via explicit
 * overrides — mirrors `meetings.facade.speaker-history.spec.ts`.
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
  { provide: AudioImportPort, useClass: InMemoryAudioImportFake },
];

describe('runSetSegmentSpeakerGroupWithHistory / grouped undo', () => {
  let store: MeetingsStore;
  let setSegmentSpeakerUseCase: SetSegmentSpeakerUseCase;
  let renameSpeakerUseCase: RenameSpeakerUseCase;
  let removeSpeakerUseCase: RemoveSpeakerUseCase;

  const meetingId = toMeetingId('m-1');

  const seededMeeting = {
    id: meetingId,
    title: 'Standup',
    createdAt: new Date(),
    durationSec: 0,
    summaries: [],
    archived: false,
    hasAudio: false,
    hasSystemTrack: false,
    droppedAudioChunks: 0,
    speakerNames: {},
    transcript: {
      segments: [
        transcriptSegment({ startSec: 0, endSec: 5, text: 'first', speaker: 'others:1' }),
        transcriptSegment({ startSec: 5, endSec: 10, text: 'second', speaker: 'others:1' }),
        transcriptSegment({ startSec: 10, endSec: 15, text: 'third', speaker: 'others:1' }),
      ],
    },
  };

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideMeetings(), ...FAKE_PORT_OVERRIDES],
    });
    const repository = TestBed.inject(MeetingRepositoryPort) as InMemoryMeetingRepositoryFake;
    repository.seed([seededMeeting]);
    // Uses the facade purely to select the meeting into the store — mirrors
    // the setup in `meetings.facade.speaker-history.spec.ts`.
    const facade = TestBed.inject(MeetingsFacade);
    await facade.openMeeting(meetingId);

    store = TestBed.inject(MeetingsStore);
    setSegmentSpeakerUseCase = TestBed.inject(SetSegmentSpeakerUseCase);
    renameSpeakerUseCase = TestBed.inject(RenameSpeakerUseCase);
    removeSpeakerUseCase = TestBed.inject(RemoveSpeakerUseCase);
  });

  it('reassigns every segment in the group and pushes ONE combined undo entry', async () => {
    await runSetSegmentSpeakerGroupWithHistory(store, setSegmentSpeakerUseCase, meetingId, [0, 1, 2], 'me');

    expect(store.selectedMeeting()?.transcript?.segments.map((segment) => segment.speaker)).toEqual(['me', 'me', 'me']);
    expect(store.speakerHistory()).toEqual([
      {
        kind: 'reassign-group',
        meetingId,
        segments: [
          { index: 0, previousLabel: 'others:1' },
          { index: 1, previousLabel: 'others:1' },
          { index: 2, previousLabel: 'others:1' },
        ],
      },
    ]);
  });

  it('one undo restores every segment the group reassign touched', async () => {
    await runSetSegmentSpeakerGroupWithHistory(store, setSegmentSpeakerUseCase, meetingId, [0, 1, 2], 'me');

    await runUndoLastSpeakerOp(store, renameSpeakerUseCase, removeSpeakerUseCase, setSegmentSpeakerUseCase);

    expect(store.selectedMeeting()?.transcript?.segments.map((segment) => segment.speaker)).toEqual([
      'others:1',
      'others:1',
      'others:1',
    ]);
    expect(store.speakerHistory()).toEqual([]);
  });
});
