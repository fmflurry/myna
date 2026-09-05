import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import type { Meeting } from '../../core/models/meeting.model';
import { toMeetingId } from '../../core/models/meeting.model';
import { MeetingsError } from '../../core/models/recording-state.model';
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
import { FINAL_BATCH_MS } from '../stores/meetings-store-wiring.support';
import { MeetingsStore } from '../stores/meetings.store';
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
import { MeetingsFacade } from './meetings.facade';

const PREVIOUSLY_SELECTED_MEETING: Meeting = {
  id: toMeetingId('m-previous'),
  title: 'Previously selected',
  createdAt: new Date(),
  durationSec: 42,
  summaries: [],
  archived: false,
  hasAudio: true,
  hasSystemTrack: true,
  droppedAudioChunks: 0,
};

const IMPORTED_MEETING: Meeting = {
  id: toMeetingId('m-imported'),
  title: 'Imported meeting',
  createdAt: new Date(),
  durationSec: 0,
  summaries: [],
  archived: false,
  hasAudio: true,
  hasSystemTrack: true,
  droppedAudioChunks: 0,
};

/**
 * Phase 4: `importAudio` / `retranscribeMeeting` / `cancelImport` wired
 * through the facade. Split out from `meetings.facade.spec.ts` to keep that
 * file under the project's max-lines limit, same pattern as
 * `meetings.facade.starting-recording.spec.ts`.
 */
describe('MeetingsFacade import', () => {
  let facade: MeetingsFacade;
  let store: MeetingsStore;
  let audioImport: InMemoryAudioImportFake;
  let fileDialog: InMemoryFileDialogFake;
  let transcriber: InMemoryTranscriberFake;

  beforeEach(() => {
    // Fake timers BEFORE the facade/store graph is constructed: the finals
    // batch window (`bufferTime(FINAL_BATCH_MS)`) schedules its flush timer
    // at subscribe time, so the clock must already be faked at injection.
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        provideMeetings(),
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
      ],
    });
    facade = TestBed.inject(MeetingsFacade);
    store = TestBed.inject(MeetingsStore);
    audioImport = TestBed.inject(AudioImportPort) as InMemoryAudioImportFake;
    fileDialog = TestBed.inject(FileDialogPort) as InMemoryFileDialogFake;
    transcriber = TestBed.inject(TranscriberPort) as InMemoryTranscriberFake;
    audioImport.seed(IMPORTED_MEETING);
    store.setSelectedMeeting(PREVIOUSLY_SELECTED_MEETING);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('importAudio', () => {
    it('is a silent no-op when the open dialog is cancelled', async () => {
      fileDialog.seed(null);

      await facade.importAudio();

      expect(facade.error()).toBeUndefined();
      expect(facade.importing()).toBe(false);
      expect(facade.selectedMeeting()).toEqual(PREVIOUSLY_SELECTED_MEETING);
    });

    it('adds and selects the meeting on success', async () => {
      fileDialog.seed('/tmp/meeting.wav');

      await facade.importAudio();

      expect(facade.selectedMeeting()).toEqual(IMPORTED_MEETING);
      expect(facade.meetings().find((meeting) => meeting.id === IMPORTED_MEETING.id)).toEqual(IMPORTED_MEETING);
      expect(facade.error()).toBeUndefined();
      expect(facade.importing()).toBe(false);
    });

    it('sets ERROR and leaves the previously selected meeting untouched on failure', async () => {
      fileDialog.seed('/tmp/meeting.wav');
      audioImport.seedError(new Error('import failed'));

      await facade.importAudio();

      expect(facade.error()?.code).toBe('UNKNOWN');
      expect(facade.selectedMeeting()).toEqual(PREVIOUSLY_SELECTED_MEETING);
      expect(facade.importing()).toBe(false);
    });

    it('leaves ERROR unset when the import is cancelled (CANCELLED code) — cancellation is not a scary error', async () => {
      fileDialog.seed('/tmp/meeting.wav');
      audioImport.seedError(new MeetingsError('CANCELLED', 'import cancelled by user'));

      await facade.importAudio();

      expect(facade.error()).toBeUndefined();
      expect(facade.importing()).toBe(false);
    });

    it('still sets ERROR for a non-CANCELLED failure (baseline: only CANCELLED is silenced)', async () => {
      fileDialog.seed('/tmp/meeting.wav');
      audioImport.seedError(new MeetingsError('IO', 'disk read failed'));

      await facade.importAudio();

      expect(facade.error()?.code).toBe('IO');
    });

    it('removes the optimistic placeholder and clears the selection when a brand-new import is CANCELLED', async () => {
      fileDialog.seed('/tmp/meeting.wav');
      const newMeetingId = toMeetingId('brand-new-import-cancelled');
      let rejectImport!: (err: unknown) => void;
      const deferred = new Promise<Meeting>((_resolve, reject) => {
        rejectImport = reject;
      });
      vi.spyOn(audioImport, 'importFile').mockReturnValue(deferred);

      const pending = facade.importAudio();
      await Promise.resolve();
      await Promise.resolve();

      audioImport.emitProgress({ meetingId: newMeetingId, phase: 'converting', processedSec: 0, totalSec: 0 });
      expect(facade.selectedMeeting()?.id).toBe(newMeetingId);
      expect(facade.meetings().some((meeting) => meeting.id === newMeetingId)).toBe(true);

      rejectImport(new MeetingsError('CANCELLED', 'import cancelled by user'));
      await pending;

      expect(facade.meetings().some((meeting) => meeting.id === newMeetingId)).toBe(false);
      expect(facade.selectedMeeting()).toBeUndefined();
      expect(facade.error()).toBeUndefined();
    });

    it('removes the optimistic placeholder and clears the selection when a brand-new import FAILS with a generic error', async () => {
      fileDialog.seed('/tmp/meeting.wav');
      const newMeetingId = toMeetingId('brand-new-import-failed');
      let rejectImport!: (err: unknown) => void;
      const deferred = new Promise<Meeting>((_resolve, reject) => {
        rejectImport = reject;
      });
      vi.spyOn(audioImport, 'importFile').mockReturnValue(deferred);

      const pending = facade.importAudio();
      await Promise.resolve();
      await Promise.resolve();

      audioImport.emitProgress({ meetingId: newMeetingId, phase: 'converting', processedSec: 0, totalSec: 0 });
      expect(facade.selectedMeeting()?.id).toBe(newMeetingId);

      rejectImport(new Error('import failed'));
      await pending;

      expect(facade.meetings().some((meeting) => meeting.id === newMeetingId)).toBe(false);
      expect(facade.selectedMeeting()).toBeUndefined();
      expect(facade.error()?.code).toBe('UNKNOWN');
    });

    it('resets the live transcript before invoking the import use case', async () => {
      fileDialog.seed('/tmp/meeting.wav');
      const callOrder: string[] = [];
      vi.spyOn(store, 'resetLiveTranscript').mockImplementation(() => {
        callOrder.push('resetLiveTranscript');
      });
      vi.spyOn(audioImport, 'importFile').mockImplementation(async () => {
        callOrder.push('importFile');
        return IMPORTED_MEETING;
      });

      await facade.importAudio();

      expect(callOrder).toEqual(['resetLiveTranscript', 'importFile']);
    });

    it('appends a transcript://final received during ingest onto finalizedSegments', async () => {
      fileDialog.seed('/tmp/meeting.wav');
      transcriber.emitFinal({
        meetingId: PREVIOUSLY_SELECTED_MEETING.id,
        segment: transcriptSegment({ startSec: 0, endSec: 1, text: 'stale leftover' }),
      });
      vi.advanceTimersByTime(FINAL_BATCH_MS);
      expect(facade.finalizedSegments().length).toBe(1);

      let resolveImport!: (meeting: Meeting) => void;
      const deferred = new Promise<Meeting>((resolve) => {
        resolveImport = resolve;
      });
      vi.spyOn(audioImport, 'importFile').mockReturnValue(deferred);

      const pending = facade.importAudio();
      // Flush the microtasks for the dialog await + resetLiveTranscript.
      await Promise.resolve();
      await Promise.resolve();
      expect(facade.finalizedSegments().length).toBe(0);

      transcriber.emitFinal({
        meetingId: IMPORTED_MEETING.id,
        segment: transcriptSegment({ startSec: 0, endSec: 2, text: 'live during ingest' }),
      });
      vi.advanceTimersByTime(FINAL_BATCH_MS);
      expect(facade.finalizedSegments().map((segment) => segment.text)).toEqual(['live during ingest']);

      resolveImport(IMPORTED_MEETING);
      await pending;

      expect(facade.finalizedSegments().map((segment) => segment.text)).toEqual(['live during ingest']);
    });
  });

  describe('retranscribeMeeting', () => {
    it('is a silent no-op when replaceAudio is true and the dialog is cancelled', async () => {
      fileDialog.seed(null);

      await facade.retranscribeMeeting(PREVIOUSLY_SELECTED_MEETING.id, true);

      expect(facade.error()).toBeUndefined();
      expect(facade.importing()).toBe(false);
      expect(facade.selectedMeeting()).toEqual(PREVIOUSLY_SELECTED_MEETING);
    });

    it('re-transcribes in place (no dialog) when replaceAudio is false, mirroring the mutation into MEETINGS and SELECTED_MEETING', async () => {
      store.setMeetings([PREVIOUSLY_SELECTED_MEETING]);
      audioImport.seed({ ...PREVIOUSLY_SELECTED_MEETING, durationSec: 99 });

      await facade.retranscribeMeeting(PREVIOUSLY_SELECTED_MEETING.id, false);

      expect(facade.selectedMeeting()?.durationSec).toBe(99);
      expect(facade.meetings()[0]?.durationSec).toBe(99);
      expect(facade.importing()).toBe(false);
    });

    it('opens the dialog and passes the chosen path when replaceAudio is true', async () => {
      fileDialog.seed('/tmp/new-audio.wav');

      await facade.retranscribeMeeting(PREVIOUSLY_SELECTED_MEETING.id, true);

      expect(audioImport.getLastRetranscribedPath()).toBe('/tmp/new-audio.wav');
      expect(audioImport.getLastRetranscribedId()).toBe(PREVIOUSLY_SELECTED_MEETING.id);
    });

    it('sets ERROR and leaves the previously selected meeting untouched on failure', async () => {
      audioImport.seedError(new Error('retranscribe failed'));

      await facade.retranscribeMeeting(PREVIOUSLY_SELECTED_MEETING.id, false);

      expect(facade.error()?.code).toBe('UNKNOWN');
      expect(facade.selectedMeeting()).toEqual(PREVIOUSLY_SELECTED_MEETING);
      expect(facade.importing()).toBe(false);
    });

    it('leaves ERROR unset when the retranscribe is cancelled (CANCELLED code) — cancellation is not a scary error', async () => {
      audioImport.seedError(new MeetingsError('CANCELLED', 'retranscribe cancelled by user'));

      await facade.retranscribeMeeting(PREVIOUSLY_SELECTED_MEETING.id, false);

      expect(facade.error()).toBeUndefined();
      expect(facade.importing()).toBe(false);
      expect(facade.selectedMeeting()).toEqual(PREVIOUSLY_SELECTED_MEETING);
    });

    it('still sets ERROR for a non-CANCELLED retranscribe failure (baseline: only CANCELLED is silenced)', async () => {
      audioImport.seedError(new MeetingsError('IO', 'disk read failed'));

      await facade.retranscribeMeeting(PREVIOUSLY_SELECTED_MEETING.id, false);

      expect(facade.error()?.code).toBe('IO');
    });

    it('resets the live transcript before invoking the retranscribe use case', async () => {
      const callOrder: string[] = [];
      vi.spyOn(store, 'resetLiveTranscript').mockImplementation(() => {
        callOrder.push('resetLiveTranscript');
      });
      vi.spyOn(audioImport, 'retranscribe').mockImplementation(async () => {
        callOrder.push('retranscribe');
        return PREVIOUSLY_SELECTED_MEETING;
      });

      await facade.retranscribeMeeting(PREVIOUSLY_SELECTED_MEETING.id, false);

      expect(callOrder).toEqual(['resetLiveTranscript', 'retranscribe']);
    });
  });

  describe('cancelImport', () => {
    it('delegates to CancelImportUseCase and clears importing', async () => {
      store.setImporting(true);

      await facade.cancelImport();

      expect(audioImport.getCancelCallCount()).toBe(1);
      expect(facade.importing()).toBe(false);
      expect(facade.error()).toBeUndefined();
    });

    it('clears importing even when cancel() fails', async () => {
      store.setImporting(true);
      audioImport.seedError(new Error('cancel failed'));

      await facade.cancelImport();

      expect(facade.importing()).toBe(false);
      expect(facade.error()?.code).toBe('UNKNOWN');
    });
  });
});
