import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

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
 * Must match `IMPORT_EVENTS_RETRY_DELAY_MS` in the GREEN implementation
 * (`meetings.store.support.ts`). Hardcoded here (rather than imported)
 * because the constant does not exist yet on the unfixed tree — see the RED
 * confirmation notes in the task report.
 */
const RETRY_DELAY_MS = 1000;

/**
 * Findings (4) and (6) from the audio-ingest code review:
 *
 * (4) The `import://progress` subscription's `error` handler was a no-op
 * (`error: () => undefined`). RxJS observables TERMINATE after an error, so a
 * single transient `listen()` failure killed the progress stream — and with
 * it the optimistic-selection UX — permanently and silently for the rest of
 * the app session. Fix: log the failure and retry with a bound.
 *
 * (6) `error://occurred` (e.g. `AUDIO_CHUNKS_DROPPED`) had zero consumers in
 * the Angular app — the event was registered in `events.ts` but nothing ever
 * called `onEvent('error://occurred')`. Fix: consume it and surface it onto
 * the shared `ERROR` slot, applying the same log+retry discipline as (4).
 */
describe('MeetingsStore import-related event stream resilience', () => {
  let store: MeetingsStore;
  let audioImport: InMemoryAudioImportFake;
  let consoleErrorSpy: MockInstance;

  beforeEach(() => {
    vi.useFakeTimers();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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

  afterEach(() => {
    vi.useRealTimers();
    consoleErrorSpy.mockRestore();
  });

  describe('import://progress stream (finding 4)', () => {
    it('logs the failure instead of silently swallowing it', () => {
      audioImport.emitProgressStreamFailure(new Error('transient listen() failure'));

      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('self-heals after a transient failure: a later progress event is still processed', () => {
      audioImport.emitProgressStreamFailure(new Error('transient listen() failure'));
      vi.advanceTimersByTime(RETRY_DELAY_MS);

      const meetingId = toMeetingId('after-retry-import');
      audioImport.emitProgress({ meetingId, phase: 'converting', processedSec: 0, totalSec: 0 });

      expect(store.selectedMeeting()?.id).toBe(meetingId);
      expect(store.importProgress()?.meetingId).toBe(meetingId);
    });
  });

  describe('error://occurred consumption (finding 6)', () => {
    it('surfaces an error://occurred payload onto the shared ERROR slot', () => {
      audioImport.emitErrorEvent('AUDIO_CHUNKS_DROPPED', 'Some audio chunks were dropped during recording');

      expect(store.error()?.code).toBe('AUDIO_CHUNKS_DROPPED');
      expect(store.error()?.message).toBe('Some audio chunks were dropped during recording');
    });

    it('logs and self-heals when the error-event stream fails transiently, instead of dying silently', () => {
      audioImport.emitErrorEventsStreamFailure(new Error('transient listen() failure'));
      expect(consoleErrorSpy).toHaveBeenCalled();

      vi.advanceTimersByTime(RETRY_DELAY_MS);
      audioImport.emitErrorEvent('IO', 'disk read failed');

      expect(store.error()?.code).toBe('IO');
    });
  });
});
