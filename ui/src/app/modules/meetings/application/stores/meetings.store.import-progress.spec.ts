import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import { AudioImportPort } from '../../core/ports/audio-import.port';
import { PreferencesPort } from '../../core/ports/preferences.port';
import { RecorderPort } from '../../core/ports/recorder.port';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import { InMemoryAudioImportFake } from '../testing/in-memory-audio-import.fake';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { InMemoryTranscriberFake } from '../testing/in-memory-transcriber.fake';
import { MeetingsStore } from './meetings.store';

/**
 * Regression guard for the brand-new "Import audio" UX hole: the facade
 * only calls `store.setSelectedMeeting()` after the import PROMISE resolves,
 * so during the (possibly multi-minute) transcription window `meeting()` was
 * `undefined` and the welcome panel — not the progress header — rendered,
 * reading as a hang. The backend saves the meeting and stamps every
 * `import://progress` event with that `meetingId` *before* transcription
 * starts, so the store can select (or optimistically insert-and-select) the
 * meeting from the very first progress event instead of waiting for the
 * import to resolve.
 */
describe('MeetingsStore import progress selects the ingesting meeting', () => {
  let store: MeetingsStore;
  let audioImport: InMemoryAudioImportFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        MeetingsStore,
        InMemoryRecorderFake,
        { provide: RecorderPort, useExisting: InMemoryRecorderFake },
        InMemoryTranscriberFake,
        { provide: TranscriberPort, useExisting: InMemoryTranscriberFake },
        { provide: SummarizerPort, useClass: InMemorySummarizerFake },
        InMemoryAudioImportFake,
        { provide: AudioImportPort, useExisting: InMemoryAudioImportFake },
        { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
      ],
    });
    store = TestBed.inject(MeetingsStore);
    audioImport = TestBed.inject(InMemoryAudioImportFake);
  });

  it('selects (and inserts) the meeting a brand-new import names on its FIRST progress event, before import_audio resolves', () => {
    const meetingId = toMeetingId('new-import-1');
    expect(store.selectedMeeting()).toBeUndefined();
    expect(store.meetings()).toEqual([]);

    audioImport.emitProgress({ meetingId, phase: 'converting', processedSec: 0, totalSec: 0 });

    expect(store.selectedMeeting()?.id).toBe(meetingId);
    expect(store.meetings().some((meeting) => meeting.id === meetingId)).toBe(true);
  });

  it('does not clobber an already-known meeting: a re-transcribe progress event for the currently selected meeting is a no-op', () => {
    const meeting = {
      id: toMeetingId('existing-meeting'),
      title: 'Weekly sync',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      durationSec: 300,
      summaries: [],
      archived: false,
      hasAudio: true,
      hasSystemTrack: true,
      droppedAudioChunks: 0,
    };
    store.setMeetings([meeting]);
    store.setSelectedMeeting(meeting);

    audioImport.emitProgress({ meetingId: meeting.id, phase: 'transcribing', processedSec: 5, totalSec: 300 });

    expect(store.selectedMeeting()).toEqual(meeting);
    expect(store.meetings()).toEqual([meeting]);
  });

  it('re-selects a known-but-not-selected meeting by its REAL record, never a placeholder, when its progress event arrives', () => {
    const meeting = {
      id: toMeetingId('other-meeting'),
      title: 'Retro',
      createdAt: new Date('2026-01-02T00:00:00Z'),
      durationSec: 600,
      summaries: [],
      archived: false,
      hasAudio: true,
      hasSystemTrack: true,
      droppedAudioChunks: 0,
    };
    store.setMeetings([meeting]);

    audioImport.emitProgress({ meetingId: meeting.id, phase: 'transcribing', processedSec: 1, totalSec: 600 });

    expect(store.selectedMeeting()).toEqual(meeting);
  });
});
