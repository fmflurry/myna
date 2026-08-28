import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import { installTauriInternalsStub, uninstallTauriInternalsStub } from './testing/tauri-internals.stub';
import { TauriMeetingRepositoryAdapter } from './tauri-meeting-repository.adapter';

describe('TauriMeetingRepositoryAdapter editTranscriptSegment', () => {
  let adapter: TauriMeetingRepositoryAdapter;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TauriMeetingRepositoryAdapter] });
    adapter = TestBed.inject(TauriMeetingRepositoryAdapter);
  });

  afterEach(() => uninstallTauriInternalsStub());

  it('invokes edit_transcript_segment with exactly meetingId, segmentIndex, text and maps the result', async () => {
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return {
        id: 'm-1',
        title: 'Standup',
        createdAt: '2026-01-15T09:00:00Z',
        durationSec: 60,
        audioPath: null,
        transcript: { segments: [{ startSec: 0, endSec: 5, text: 'corrected' }] },
        summaries: [],
        archived: false,
      };
    });

    const meeting = await adapter.editTranscriptSegment(toMeetingId('m-1'), 0, 'corrected');

    expect(receivedCmd).toBe('edit_transcript_segment');
    expect(receivedArgs).toEqual({ meetingId: 'm-1', segmentIndex: 0, text: 'corrected' });
    expect(meeting.transcript?.segments[0]?.text).toBe('corrected');
  });
});
