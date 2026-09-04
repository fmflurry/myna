import { TestBed } from '@angular/core/testing';
import type { Observable } from 'rxjs';

import type { Meeting } from '../../core/models/meeting.model';
import { toMeetingId } from '../../core/models/meeting.model';
import {
  flushMicrotasks,
  installTauriInternalsStub,
  uninstallTauriInternalsStub,
} from './testing/tauri-internals.stub';
import { TauriRecorderAdapter } from './tauri-recorder.adapter';

// --- Stop-phase contract (sync Stop landing) ---
// Backend events: `recording://health`, `recording://stop-progress`, `recording://completed`.
// `stop_recording` resolves with the finalized `MeetingDto` (mapped here via
// `mapMeetingDtoToDomain`); only `cancel_recording` resolves IMMEDIATELY with
// an acknowledgement. The `recording://completed` event does not exist on the
// backend — the completed stream is a best-effort mirror for fakes/legacy emitters.
// Split out from `tauri-recorder.adapter.spec.ts` to keep that file under the
// project's max-lines limit; the command/event mapping of start/state/levels
// lives there.
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

interface StopAcknowledgement {
  readonly accepted: true;
}

/** The port surface these tests specify, before production code declares it. */
interface RecorderStopPhaseSurface {
  stop(): Promise<Meeting>;
  cancel(): Promise<StopAcknowledgement>;
  stopProgressChanges(): Observable<StopPhase>;
  completedMeetings(): Observable<Meeting>;
  healthChanges(): Observable<RecordingHealthEvent>;
}

describe('TauriRecorderAdapter stop-phase contract', () => {
  let adapter: TauriRecorderAdapter;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TauriRecorderAdapter] });
    adapter = TestBed.inject(TauriRecorderAdapter);
  });

  afterEach(() => uninstallTauriInternalsStub());

  it('stop() maps the finalized MeetingDto returned by stop_recording', async () => {
    let receivedCmd: string | undefined;
    installTauriInternalsStub((cmd) => {
      receivedCmd = cmd;
      return {
        id: 'm-9',
        title: 'Standup',
        createdAt: '2026-01-15T09:30:00Z',
        durationSec: 125,
        audioPath: null,
        transcript: null,
        summaries: [],
        archived: false,
        hasAudio: true,
        hasSystemTrack: false,
        droppedAudioChunks: 0,
        folderId: null,
      };
    });

    const surface = adapter as unknown as RecorderStopPhaseSurface;
    const meeting = await surface.stop();

    expect(receivedCmd).toBe('stop_recording');
    expect(meeting).toEqual({
      id: toMeetingId('m-9'),
      title: 'Standup',
      createdAt: new Date('2026-01-15T09:30:00Z'),
      durationSec: 125,
      summaries: [],
      archived: false,
      hasAudio: true,
      hasSystemTrack: false,
      droppedAudioChunks: 0,
    });
  });

  it('cancel() resolves with the acknowledgement payload, NOT void', async () => {
    let receivedCmd: string | undefined;
    installTauriInternalsStub((cmd) => {
      receivedCmd = cmd;
      return { accepted: true };
    });

    const surface = adapter as unknown as RecorderStopPhaseSurface;
    const acknowledgement = await surface.cancel();

    expect(receivedCmd).toBe('cancel_recording');
    expect(acknowledgement).toEqual({ accepted: true });
  });

  it('stopProgressChanges() maps the phase field of every recording://stop-progress event', async () => {
    const stub = installTauriInternalsStub((cmd) => {
      throw new Error(`unexpected command '${cmd}'`);
    });

    const surface = adapter as unknown as RecorderStopPhaseSurface;
    const results: StopPhase[] = [];
    surface.stopProgressChanges().subscribe((phase) => results.push(phase));
    await flushMicrotasks();

    stub.emit('recording://stop-progress', { phase: 'stopping-capture' });
    stub.emit('recording://stop-progress', { phase: 'finalizing-transcript' });
    stub.emit('recording://stop-progress', { phase: 'saving' });

    expect(results).toEqual(['stopping-capture', 'finalizing-transcript', 'saving']);
  });

  it('completedMeetings() maps the meeting DTO carried by a recording://completed event', async () => {
    const stub = installTauriInternalsStub((cmd) => {
      throw new Error(`unexpected command '${cmd}'`);
    });

    const surface = adapter as unknown as RecorderStopPhaseSurface;
    const results: Meeting[] = [];
    surface.completedMeetings().subscribe((meeting) => results.push(meeting));
    await flushMicrotasks();

    stub.emit('recording://completed', {
      meeting: {
        id: 'm-9',
        title: 'Standup',
        createdAt: '2026-01-15T09:30:00Z',
        durationSec: 125,
        audioPath: null,
        transcript: null,
        summaries: [],
        archived: false,
        hasAudio: true,
        hasSystemTrack: false,
        droppedAudioChunks: 0,
        folderId: null,
      },
    });

    expect(results).toEqual([
      {
        id: toMeetingId('m-9'),
        title: 'Standup',
        createdAt: new Date('2026-01-15T09:30:00Z'),
        durationSec: 125,
        summaries: [],
        archived: false,
        hasAudio: true,
        hasSystemTrack: false,
        droppedAudioChunks: 0,
      },
    ]);
  });

  it('healthChanges() passes every recording://health event through verbatim', async () => {
    const stub = installTauriInternalsStub((cmd) => {
      throw new Error(`unexpected command '${cmd}'`);
    });

    const surface = adapter as unknown as RecorderStopPhaseSurface;
    const results: RecordingHealthEvent[] = [];
    surface.healthChanges().subscribe((event) => results.push(event));
    await flushMicrotasks();

    stub.emit('recording://health', {
      category: 'disk',
      severity: 'warning',
      message: 'Less than 1 GB free on the recordings volume',
    });
    stub.emit('recording://health', {
      category: 'journal',
      severity: 'error',
      message: 'Transcript journal write failed',
    });

    expect(results).toEqual([
      {
        category: 'disk',
        severity: 'warning',
        message: 'Less than 1 GB free on the recordings volume',
      },
      { category: 'journal', severity: 'error', message: 'Transcript journal write failed' },
    ]);
  });
});
