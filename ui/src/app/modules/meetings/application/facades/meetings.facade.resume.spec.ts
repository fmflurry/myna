import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { toMeetingId } from '../../core/models/meeting.model';
import { AppInfoPort } from '../../core/ports/app-info.port';
import { FileDialogPort } from '../../core/ports/file-dialog.port';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';
import { ModelsStatusPort } from '../../core/ports/models-status.port';
import { PreferencesPort } from '../../core/ports/preferences.port';
import type { RecordingSnapshot } from '../../core/ports/recorder.port';
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
import { transcriptSegment } from '../testing/transcript-segment.factory';
import { MeetingsFacade } from './meetings.facade';

/**
 * `resumeActiveRecording` — the ADR 0011 boot re-attach, tested against the
 * real facade/store graph with only the ports faked. The incident this covers:
 * a webview reload mid-meeting left the UI with no Stop button, a 0-min timer,
 * and no transcript, because recording state lived only in events that had
 * already fired. Resume recovers all three from the two query commands.
 */
describe('MeetingsFacade resumeActiveRecording (ADR 0011 re-attach)', () => {
  let facade: MeetingsFacade;
  let recorder: InMemoryRecorderFake;
  let transcriber: InMemoryTranscriberFake;
  let repository: InMemoryMeetingRepositoryFake;

  const meeting = (id: MeetingId): Meeting => ({
    id,
    title: 'Standup',
    createdAt: new Date(),
    durationSec: 0,
    summaries: [],
    archived: false,
    hasAudio: false,
    hasSystemTrack: false,
    droppedAudioChunks: 0,
  });

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideMeetings(),
        InMemoryRecorderFake,
        { provide: RecorderPort, useExisting: InMemoryRecorderFake },
        InMemoryTranscriberFake,
        { provide: TranscriberPort, useExisting: InMemoryTranscriberFake },
        InMemoryMeetingRepositoryFake,
        { provide: MeetingRepositoryPort, useExisting: InMemoryMeetingRepositoryFake },
        { provide: SummarizerPort, useClass: InMemorySummarizerFake },
        { provide: TemplateRepositoryPort, useClass: InMemoryTemplateRepositoryFake },
        { provide: ModelsStatusPort, useClass: InMemoryModelsStatusFake },
        { provide: FileDialogPort, useClass: InMemoryFileDialogFake },
        { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
        { provide: AppInfoPort, useClass: InMemoryAppInfoFake },
      ],
    });
    facade = TestBed.inject(MeetingsFacade);
    recorder = TestBed.inject(InMemoryRecorderFake);
    transcriber = TestBed.inject(InMemoryTranscriberFake);
    repository = TestBed.inject(InMemoryMeetingRepositoryFake);
  });

  const stubState = (snapshot: RecordingSnapshot): void => {
    vi.spyOn(recorder, 'state').mockResolvedValue(snapshot);
  };

  it('restores selection, journaled finals, state, and the elapsed baseline for a live session', async () => {
    repository.seed([meeting(toMeetingId('m1'))]);
    stubState({ state: 'recording', meetingId: toMeetingId('m1'), elapsedSec: 125 });
    vi.spyOn(transcriber, 'liveTranscriptFor').mockResolvedValue({
      segments: [
        transcriptSegment({ startSec: 0, endSec: 5, text: 'Welcome.', speaker: 'me' }),
        transcriptSegment({ startSec: 6, endSec: 11, text: 'Hi.', speaker: 'others' }),
      ],
    });

    await facade.resumeActiveRecording();

    expect(facade.selectedMeeting()?.id).toBe(toMeetingId('m1'));
    expect(facade.finalizedSegments().map((segment) => segment.text)).toEqual(['Welcome.', 'Hi.']);
    expect(facade.recordingState()).toBe('recording');
    expect(facade.busy()).toBe(true);
    expect(facade.activeRecording()).toEqual({ meetingId: toMeetingId('m1'), elapsedSec: 125 });
  });

  it('queries the live journal for the snapshot meeting id', async () => {
    repository.seed([meeting(toMeetingId('m1'))]);
    stubState({ state: 'recording', meetingId: toMeetingId('m1'), elapsedSec: 3 });
    const liveSpy = vi.spyOn(transcriber, 'liveTranscriptFor').mockResolvedValue({ segments: [] });

    await facade.resumeActiveRecording();

    expect(liveSpy).toHaveBeenCalledWith(toMeetingId('m1'));
  });

  it('leaves everything untouched when no session is live', async () => {
    stubState({ state: 'idle', meetingId: null, elapsedSec: null });
    const liveSpy = vi.spyOn(transcriber, 'liveTranscriptFor');

    await facade.resumeActiveRecording();

    expect(facade.recordingState()).toBe('idle');
    expect(facade.activeRecording()).toBeNull();
    expect(facade.selectedMeeting()).toBeUndefined();
    expect(liveSpy).not.toHaveBeenCalled();
  });

  it('publishes slots only for a stopping session — no open, no journal replay', async () => {
    stubState({ state: 'stopping', meetingId: toMeetingId('m1'), elapsedSec: 42 });
    const openSpy = vi.spyOn(repository, 'get');
    const liveSpy = vi.spyOn(transcriber, 'liveTranscriptFor');

    await facade.resumeActiveRecording();

    expect(facade.recordingState()).toBe('stopping');
    expect(facade.activeRecording()).toEqual({ meetingId: toMeetingId('m1'), elapsedSec: 42 });
    expect(openSpy).not.toHaveBeenCalled();
    expect(liveSpy).not.toHaveBeenCalled();
  });

  it('tolerates a session that stops mid-resume: empty journal seeds empty and the state still restores', async () => {
    repository.seed([meeting(toMeetingId('m1'))]);
    stubState({ state: 'recording', meetingId: toMeetingId('m1'), elapsedSec: 10 });
    vi.spyOn(transcriber, 'liveTranscriptFor').mockResolvedValue({ segments: [] });

    await facade.resumeActiveRecording();

    expect(facade.finalizedSegments()).toEqual([]);
    expect(facade.recordingState()).toBe('recording');
    expect(facade.activeRecording()?.elapsedSec).toBe(10);
  });

  it('continues appending live finals after seeding, deduping the journal replay against stream arrivals', async () => {
    repository.seed([meeting(toMeetingId('m1'))]);
    stubState({ state: 'recording', meetingId: toMeetingId('m1'), elapsedSec: 20 });
    const overlapping = transcriptSegment({ startSec: 0, endSec: 5, text: 'Journaled.', speaker: 'me' });
    vi.spyOn(transcriber, 'liveTranscriptFor').mockResolvedValue({ segments: [overlapping] });

    // The live stream delivers the final BEFORE the journal query is folded
    // in — the seed merge is what keeps the overlap from double-rendering.
    transcriber.emitFinal({ meetingId: toMeetingId('m1'), segment: overlapping });
    await facade.resumeActiveRecording();
    transcriber.emitFinal({
      meetingId: toMeetingId('m1'),
      segment: transcriptSegment({ startSec: 21, endSec: 24, text: 'Fresh.', speaker: 'others' }),
    });

    expect(facade.finalizedSegments().map((segment) => segment.text)).toEqual(['Journaled.', 'Fresh.']);
  });

  it('still restores the Stop branch when the journal replay rejects: a corrupt journal must not cost the user the live session', async () => {
    repository.seed([meeting(toMeetingId('m1'))]);
    stubState({ state: 'recording', meetingId: toMeetingId('m1'), elapsedSec: 60 });
    vi.spyOn(transcriber, 'liveTranscriptFor').mockRejectedValue(new Error('journal corrupt'));

    await facade.resumeActiveRecording();

    // The transcript replay is best-effort; the recording state and elapsed
    // baseline are not — losing them is the exact reload incident ADR 0011
    // exists to fix.
    expect(facade.recordingState()).toBe('recording');
    expect(facade.activeRecording()).toEqual({ meetingId: toMeetingId('m1'), elapsedSec: 60 });
    expect(facade.finalizedSegments()).toEqual([]);
  });

  it('never rejects when the state query fails — boot detection is best-effort', async () => {
    vi.spyOn(recorder, 'state').mockRejectedValue(new Error('ipc down'));

    await facade.resumeActiveRecording();

    expect(facade.recordingState()).toBe('idle');
    expect(facade.activeRecording()).toBeNull();
  });

  it('retires the restored baseline once the session goes idle (never leaks into the next recording)', async () => {
    repository.seed([meeting(toMeetingId('m1'))]);
    stubState({ state: 'recording', meetingId: toMeetingId('m1'), elapsedSec: 125 });
    vi.spyOn(transcriber, 'liveTranscriptFor').mockResolvedValue({ segments: [] });
    await facade.resumeActiveRecording();
    expect(facade.activeRecording()?.elapsedSec).toBe(125);

    // The backend's idle event is what retires the slot on the event-fed path.
    await recorder.cancel();

    expect(facade.recordingState()).toBe('idle');
    expect(facade.activeRecording()).toBeNull();
  });
});
