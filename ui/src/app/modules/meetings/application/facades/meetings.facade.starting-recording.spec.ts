import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import type { Meeting } from '../../core/models/meeting.model';
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

// --- Stop-phase contract (defined by these tests; production code must grow to match) ---
type StopPhase =
  | 'stopping-capture'
  | 'finalizing-transcript'
  | 'saving'
  | 'discarding'
  | 'recovering'
  | 'completed'
  | 'failed';

type RecordingHealthCategory = 'wav-write' | 'journal' | 'decode-drop' | 'tap-rebuild' | 'disk';
type RecordingHealthSeverity = 'warning' | 'error' | 'fatal';

interface RecordingHealthEvent {
  readonly category: RecordingHealthCategory;
  readonly severity: RecordingHealthSeverity;
  readonly message: string;
}

/** The fake-recorder emit helpers the stop-phase contract requires. */
interface StopPhaseRecorderSurface {
  emitStopProgress?(phase: StopPhase): void;
  emitCompletedMeeting?(meeting: Meeting): void;
  emitHealth?(event: RecordingHealthEvent): void;
}

/** The facade signals the stop-phase contract requires. */
interface StopPhaseFacadeSurface {
  stopPhase?(): StopPhase | null;
  recordingHealth?(): RecordingHealthEvent | null;
}

/** Drains every pending microtask/timer hop so store wiring settles. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * Split out from `meetings.facade.spec.ts` to keep that file under the
 * project's max-lines limit (see `meetings-shell.page.selection.spec.ts` for
 * the same pattern applied to a page spec). Covers the "preparing to
 * record" window: `startRecording` awaits STT model load before
 * `recordingState` ever leaves `'idle'`, so the UI needs its own signal to
 * show activity during that gap.
 */
describe('MeetingsFacade startingRecording', () => {
  let facade: MeetingsFacade;

  beforeEach(() => {
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
      ],
    });
    facade = TestBed.inject(MeetingsFacade);
  });

  it('is true while the model-loading start() call is in flight, and clears once settled', async () => {
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    let resolveStart!: (meeting: Meeting) => void;
    const deferred = new Promise<Meeting>((resolve) => {
      resolveStart = resolve;
    });
    vi.spyOn(recorder, 'start').mockReturnValue(deferred);
    expect(facade.startingRecording()).toBe(false);

    const pending = facade.startRecording('Standup');
    expect(facade.startingRecording()).toBe(true);

    resolveStart({
      id: toMeetingId('m-1'),
      title: 'Standup',
      createdAt: new Date(),
      durationSec: 0,
      summaries: [],
      archived: false,
      hasAudio: false, hasSystemTrack: false,
      droppedAudioChunks: 0,
    });
    await pending;

    expect(facade.startingRecording()).toBe(false);
  });

  it('clears even when start() fails', async () => {
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    vi.spyOn(recorder, 'start').mockRejectedValue(new Error('boom'));

    await facade.startRecording('Standup');

    expect(facade.startingRecording()).toBe(false);
    expect(facade.error()?.code).toBe('UNKNOWN');
  });

  it('leaves the meetings list unchanged (no phantom row) when start() fails', async () => {
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    vi.spyOn(recorder, 'start').mockRejectedValue(new Error('boom'));
    expect(facade.meetings()).toEqual([]);

    await facade.startRecording('Standup');

    expect(facade.meetings()).toEqual([]);
  });
});

/**
 * Stop-phase reconciliation contract: `stopRecording()` only sends the stop
 * command and resolves with an acknowledgement — the durable meeting arrives
 * later via the `recording://completed` event, which is the ONLY thing that
 * may take the UI back to `'idle'`. Until then the state machine parks on
 * `'stopping'` (never a premature idle, never a phantom row from the ack).
 */
describe('MeetingsFacade stop-phase reconciliation', () => {
  let facade: MeetingsFacade;

  beforeEach(() => {
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
      ],
    });
    facade = TestBed.inject(MeetingsFacade);
  });

  /** Starts a recording and resolves the in-flight stop command with the finalized meeting. */
  const startWithFinalizingStop = async (): Promise<{
    recorder: InMemoryRecorderFake;
    started: Meeting;
  }> => {
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    await facade.startRecording('Standup');
    const started = facade.selectedMeeting();
    if (!started) {
      throw new Error('spec precondition: startRecording must select the created meeting');
    }
    vi.spyOn(recorder, 'stop').mockResolvedValue({ ...started, durationSec: 125, hasAudio: true });
    return { recorder, started };
  };

  it('parks on "stopping" when the stop command resolves with the finalized meeting, and goes idle ONLY on the completed event', async () => {
    const { recorder, started } = await startWithFinalizingStop();
    const finalized: Meeting = { ...started, durationSec: 125, hasAudio: true };

    await facade.stopRecording();
    expect(facade.recordingState()).toBe('stopping');

    const fake = recorder as unknown as StopPhaseRecorderSurface;
    fake.emitCompletedMeeting?.(finalized);
    await settle();

    expect(facade.recordingState()).toBe('idle');
  });

  it('adds and selects the durable meeting exactly once when the completed event arrives', async () => {
    const { recorder, started } = await startWithFinalizingStop();
    const finalized: Meeting = { ...started, durationSec: 125, hasAudio: true };

    await facade.stopRecording();
    const fake = recorder as unknown as StopPhaseRecorderSurface;
    fake.emitCompletedMeeting?.(finalized);
    await settle();

    const rows = facade.meetings().filter((meeting) => meeting.id === started.id);
    expect(rows.length).toBe(1);
    expect(rows[0]?.durationSec).toBe(125);
    expect(facade.selectedMeeting()?.id).toEqual(started.id);
    expect(facade.selectedMeeting()?.durationSec).toBe(125);
  });

  it('mirrors the finalized meeting from the stop result itself, with no duplicate after the completed event', async () => {
    const { recorder, started } = await startWithFinalizingStop();
    const finalized: Meeting = { ...started, durationSec: 125, hasAudio: true };

    await facade.stopRecording();
    await settle();

    // Sync Stop landing: the stop result is mirrored into both read paths the
    // moment the stop settles — no wait for the completed event.
    const mirrored = facade.meetings().filter((meeting) => meeting.id === started.id);
    expect(mirrored.length).toBe(1);
    expect(mirrored[0]?.durationSec).toBe(125);
    expect(facade.selectedMeeting()?.id).toEqual(started.id);
    expect(facade.selectedMeeting()?.durationSec).toBe(125);

    // The best-effort completed mirror upserts by id — exactly-once, never a duplicate.
    const fake = recorder as unknown as StopPhaseRecorderSurface;
    fake.emitCompletedMeeting?.(finalized);
    await settle();

    const rows = facade.meetings().filter((meeting) => meeting.id === started.id);
    expect(rows.length).toBe(1);
    expect(rows[0]?.durationSec).toBe(125);
    expect(facade.selectedMeeting()?.id).toEqual(started.id);
  });

  it('exposes the current stop phase from recording://stop-progress events, cleared by completion', async () => {
    const { recorder, started } = await startWithFinalizingStop();
    const fake = recorder as unknown as StopPhaseRecorderSurface;
    const surface = facade as unknown as StopPhaseFacadeSurface;
    await facade.stopRecording();

    fake.emitStopProgress?.('stopping-capture');
    expect(surface.stopPhase?.()).toBe('stopping-capture');
    fake.emitStopProgress?.('finalizing-transcript');
    expect(surface.stopPhase?.()).toBe('finalizing-transcript');

    fake.emitCompletedMeeting?.({ ...started, durationSec: 125 });
    await settle();
    expect(surface.stopPhase?.()).toBeNull();
  });

  it('surfaces the latest recording health event on the facade', async () => {
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    const fake = recorder as unknown as StopPhaseRecorderSurface;
    const surface = facade as unknown as StopPhaseFacadeSurface;
    const event: RecordingHealthEvent = {
      category: 'journal',
      severity: 'error',
      message: 'Transcript journal write failed',
    };

    fake.emitHealth?.(event);
    await settle();

    expect(surface.recordingHealth?.()).toEqual(event);
  });
});
