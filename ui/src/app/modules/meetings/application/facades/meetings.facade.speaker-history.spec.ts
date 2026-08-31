import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { toMeetingId } from '../../core/models/meeting.model';
import { MeetingsError } from '../../core/models/recording-state.model';
import { transcriptSegment } from '../testing/transcript-segment.factory';
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
  { provide: AudioImportPort, useClass: InMemoryAudioImportFake },
];

describe('MeetingsFacade speaker-op undo history', () => {
  let facade: MeetingsFacade;
  let repository: InMemoryMeetingRepositoryFake;
  let fileDialog: InMemoryFileDialogFake;
  let audioImport: InMemoryAudioImportFake;

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
    speakerNames: { 'others:1': 'Jean' },
    transcript: {
      segments: [
        transcriptSegment({ startSec: 0, endSec: 5, text: 'first', speaker: 'others:1' }),
        transcriptSegment({ startSec: 5, endSec: 10, text: 'second', speaker: 'others' }),
        transcriptSegment({ startSec: 10, endSec: 15, text: 'third', speaker: 'others:1' }),
      ],
    },
  };

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideMeetings(), ...FAKE_PORT_OVERRIDES],
    });
    facade = TestBed.inject(MeetingsFacade);
    repository = TestBed.inject(MeetingRepositoryPort) as InMemoryMeetingRepositoryFake;
    fileDialog = TestBed.inject(FileDialogPort) as InMemoryFileDialogFake;
    audioImport = TestBed.inject(AudioImportPort) as InMemoryAudioImportFake;
    repository.seed([seededMeeting]);
    await facade.openMeeting(meetingId);
  });

  it('starts with an empty undo stack', () => {
    expect(facade.speakerHistory()).toEqual([]);
  });

  it('captures the rename inverse and undo restores the previous name through the fake', async () => {
    await facade.renameSpeaker(meetingId, 'others:1', 'Jeanne');
    expect(facade.selectedMeeting()?.speakerNames?.['others:1']).toBe('Jeanne');
    expect(facade.speakerHistory()).toEqual([
      { kind: 'rename', meetingId, label: 'others:1', previousName: 'Jean' },
    ]);

    await facade.undoLastSpeakerOp();

    expect(facade.selectedMeeting()?.speakerNames?.['others:1']).toBe('Jean');
    expect(facade.speakerHistory()).toEqual([]);
  });

  it('captures the remove inverse and undo re-executes per-segment label restoration plus the name', async () => {
    await facade.removeSpeaker(meetingId, 'others:1');
    const removed = facade.selectedMeeting();
    expect(removed?.speakerNames?.['others:1']).toBeUndefined();
    expect(removed?.transcript?.segments.map((segment) => segment.speaker)).toEqual(['others', 'others', 'others']);
    expect(facade.speakerHistory()).toEqual([
      {
        kind: 'remove',
        meetingId,
        label: 'others:1',
        previousName: 'Jean',
        segments: [
          { index: 0, previousLabel: 'others:1' },
          { index: 2, previousLabel: 'others:1' },
        ],
      },
    ]);

    await facade.undoLastSpeakerOp();

    const restored = facade.selectedMeeting();
    expect(restored?.speakerNames?.['others:1']).toBe('Jean');
    expect(restored?.transcript?.segments.map((segment) => segment.speaker)).toEqual(['others:1', 'others', 'others:1']);
    expect(facade.speakerHistory()).toEqual([]);
  });

  it('captures the reassign inverse and undo restores the segment label', async () => {
    await facade.setSegmentSpeaker(meetingId, 1, 'others:1');
    expect(facade.selectedMeeting()?.transcript?.segments[1]?.speaker).toBe('others:1');
    expect(facade.speakerHistory()).toEqual([{ kind: 'reassign', meetingId, index: 1, previousLabel: 'others' }]);

    await facade.undoLastSpeakerOp();

    expect(facade.selectedMeeting()?.transcript?.segments[1]?.speaker).toBe('others');
    expect(facade.speakerHistory()).toEqual([]);
  });

  it('pushes nothing when the forward mutation is rejected', async () => {
    vi.spyOn(repository, 'renameSpeaker').mockRejectedValueOnce(new MeetingsError('BUSY', 'Meeting is recording.'));

    await facade.renameSpeaker(meetingId, 'others:1', 'Jeanne');

    expect(facade.error()?.code).toBe('BUSY');
    expect(facade.speakerHistory()).toEqual([]);
  });

  it('drops the op and surfaces the error when the inverse fails', async () => {
    await facade.renameSpeaker(meetingId, 'others:1', 'Jeanne');
    vi.spyOn(repository, 'renameSpeaker').mockRejectedValueOnce(new MeetingsError('BUSY', 'Meeting is recording.'));

    await facade.undoLastSpeakerOp();

    expect(facade.error()?.code).toBe('BUSY');
    expect(facade.speakerHistory()).toEqual([]);
    expect(facade.selectedMeeting()?.speakerNames?.['others:1']).toBe('Jeanne');
  });

  it('caps the stack at 50 ops, dropping the oldest', async () => {
    for (let index = 0; index < 55; index += 1) {
      await facade.renameSpeaker(meetingId, 'others:1', `Name ${index}`);
    }

    const history = facade.speakerHistory();
    expect(history.length).toBe(50);
    expect(history[0]).toEqual({ kind: 'rename', meetingId, label: 'others:1', previousName: 'Name 4' });
    expect(history.at(-1)).toEqual({ kind: 'rename', meetingId, label: 'others:1', previousName: 'Name 53' });
  });

  it('clears the stack when a different meeting is opened', async () => {
    await facade.renameSpeaker(meetingId, 'others:1', 'Jeanne');
    expect(facade.speakerHistory().length).toBe(1);

    repository.seed([{ ...seededMeeting, id: toMeetingId('m-2'), title: 'Other' }]);
    await facade.openMeeting(toMeetingId('m-2'));

    expect(facade.speakerHistory()).toEqual([]);
  });

  it('clears the stack and no-ops undo when the import path selects a different meeting', async () => {
    await facade.renameSpeaker(meetingId, 'others:1', 'Jeanne');
    expect(facade.speakerHistory().length).toBe(1);

    // Meeting B has NO 'others:1' name entry — if the stale meeting-A inverse
    // were executed against it, undo would write a bogus entry.
    const meetingB = { ...seededMeeting, id: toMeetingId('m-2'), title: 'Other', speakerNames: {} };
    repository.seed([seededMeeting, meetingB]);
    audioImport.seed(meetingB);
    fileDialog.seed('/tmp/meeting-b.wav');
    await facade.importAudio();

    expect(facade.selectedMeeting()?.id).toBe(toMeetingId('m-2'));
    expect(facade.speakerHistory()).toEqual([]);

    await facade.undoLastSpeakerOp();

    expect(facade.error()).toBeUndefined();
    expect(facade.selectedMeeting()?.speakerNames?.['others:1']).toBeUndefined();
  });

  it('undo is a no-op on an empty stack', async () => {
    await facade.undoLastSpeakerOp();

    expect(facade.error()).toBeUndefined();
    expect(facade.speakerHistory()).toEqual([]);
  });
});
