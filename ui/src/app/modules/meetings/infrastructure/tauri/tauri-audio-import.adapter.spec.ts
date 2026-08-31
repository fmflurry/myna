import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import {
  flushMicrotasks,
  installTauriInternalsStub,
  uninstallTauriInternalsStub,
} from './testing/tauri-internals.stub';
import { TauriAudioImportAdapter } from './tauri-audio-import.adapter';

const MEETING_DTO = {
  id: 'm-1',
  title: 'Imported meeting',
  createdAt: '2026-01-15T09:00:00Z',
  durationSec: 60,
  audioPath: '/data/meetings/m-1/audio.wav',
  transcript: null,
  summaries: [],
  archived: false,
  hasAudio: true,
  droppedAudioChunks: 0,
};

describe('TauriAudioImportAdapter', () => {
  let adapter: TauriAudioImportAdapter;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TauriAudioImportAdapter] });
    adapter = TestBed.inject(TauriAudioImportAdapter);
  });

  afterEach(() => uninstallTauriInternalsStub());

  it('importFile() invokes import_audio with the path only when no title is given', async () => {
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return MEETING_DTO;
    });

    const meeting = await adapter.importFile('/tmp/recording.m4a');

    expect(receivedCmd).toBe('import_audio');
    expect(receivedArgs).toEqual({ path: '/tmp/recording.m4a' });
    expect(meeting.id).toBe(toMeetingId('m-1'));
    expect(meeting.title).toBe('Imported meeting');
  });

  it('importFile() forwards an explicit title', async () => {
    let receivedArgs: unknown;
    installTauriInternalsStub((_cmd, args) => {
      receivedArgs = args;
      return MEETING_DTO;
    });

    await adapter.importFile('/tmp/recording.m4a', 'Weekly sync');

    expect(receivedArgs).toEqual({ path: '/tmp/recording.m4a', title: 'Weekly sync' });
  });

  it('retranscribe() invokes retranscribe_meeting with the meetingId only when no path is given', async () => {
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return MEETING_DTO;
    });

    const meeting = await adapter.retranscribe(toMeetingId('m-1'));

    expect(receivedCmd).toBe('retranscribe_meeting');
    expect(receivedArgs).toEqual({ meetingId: 'm-1' });
    expect(meeting.id).toBe(toMeetingId('m-1'));
  });

  it('retranscribe() forwards an explicit path', async () => {
    let receivedArgs: unknown;
    installTauriInternalsStub((_cmd, args) => {
      receivedArgs = args;
      return MEETING_DTO;
    });

    await adapter.retranscribe(toMeetingId('m-1'), '/tmp/other.wav');

    expect(receivedArgs).toEqual({ meetingId: 'm-1', path: '/tmp/other.wav' });
  });

  it('cancel() invokes cancel_import with no arguments', async () => {
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return undefined;
    });

    await adapter.cancel();

    expect(receivedCmd).toBe('cancel_import');
    expect(receivedArgs).toEqual({});
  });

  it('progress() maps the import://progress event payload to the domain shape', async () => {
    const stub = installTauriInternalsStub((cmd) => {
      throw new Error(`unexpected command '${cmd}'`);
    });

    const results: unknown[] = [];
    adapter.progress().subscribe((progress) => results.push(progress));
    await flushMicrotasks();

    stub.emit('import://progress', {
      meetingId: 'm-1',
      phase: 'transcribing',
      processedSec: 30,
      totalSec: 60,
    });

    expect(results).toEqual([
      { meetingId: toMeetingId('m-1'), phase: 'transcribing', processedSec: 30, totalSec: 60 },
    ]);
  });
});
