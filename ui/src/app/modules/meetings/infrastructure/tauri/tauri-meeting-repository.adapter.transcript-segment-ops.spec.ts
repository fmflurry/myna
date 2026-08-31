import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import { installTauriInternalsStub, uninstallTauriInternalsStub } from './testing/tauri-internals.stub';
import { TauriMeetingRepositoryAdapter } from './tauri-meeting-repository.adapter';

describe('TauriMeetingRepositoryAdapter transcript segment ops', () => {
  let adapter: TauriMeetingRepositoryAdapter;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TauriMeetingRepositoryAdapter] });
    adapter = TestBed.inject(TauriMeetingRepositoryAdapter);
  });

  afterEach(() => uninstallTauriInternalsStub());

  const meetingDto = {
    id: 'm-1',
    title: 'Standup',
    createdAt: '2026-01-15T09:00:00Z',
    durationSec: 60,
    audioPath: null,
    transcript: { segments: [{ startSec: 0, endSec: 5, text: 'remaining', speaker: 'me', speakerPinned: false }] },
    summaries: [],
    archived: false,
  };

  it('invokes delete_transcript_segment with exactly meetingId, segmentIndex, expectedText', async () => {
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return meetingDto;
    });

    const meeting = await adapter.deleteTranscriptSegment(toMeetingId('m-1'), 1, 'stale text');

    expect(receivedCmd).toBe('delete_transcript_segment');
    expect(receivedArgs).toEqual({ meetingId: 'm-1', segmentIndex: 1, expectedText: 'stale text' });
    expect(meeting.transcript?.segments[0]?.text).toBe('remaining');
  });

  it('invokes merge_transcript_segment_up with exactly meetingId, segmentIndex, expectedText', async () => {
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return meetingDto;
    });

    const meeting = await adapter.mergeTranscriptSegmentUp(toMeetingId('m-1'), 1, 'stale text');

    expect(receivedCmd).toBe('merge_transcript_segment_up');
    expect(receivedArgs).toEqual({ meetingId: 'm-1', segmentIndex: 1, expectedText: 'stale text' });
    expect(meeting.transcript?.segments[0]?.text).toBe('remaining');
  });

  it('invokes restore_transcript_segments, mapping segments to the wire shape with speakerPinned defaulted', async () => {
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return meetingDto;
    });

    const meeting = await adapter.restoreTranscriptSegments(toMeetingId('m-1'), 0, 1, [
      { startSec: 0, endSec: 2, text: 'first', speaker: 'me' },
      { startSec: 2, endSec: 5, text: 'second', speaker: 'others', speakerPinned: true },
    ]);

    expect(receivedCmd).toBe('restore_transcript_segments');
    expect(receivedArgs).toEqual({
      meetingId: 'm-1',
      segmentIndex: 0,
      removeCount: 1,
      segments: [
        { startSec: 0, endSec: 2, text: 'first', speaker: 'me', speakerPinned: false },
        { startSec: 2, endSec: 5, text: 'second', speaker: 'others', speakerPinned: true },
      ],
    });
    expect(meeting.transcript?.segments[0]?.text).toBe('remaining');
  });
});
