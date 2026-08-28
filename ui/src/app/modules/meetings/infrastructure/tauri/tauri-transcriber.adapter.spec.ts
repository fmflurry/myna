import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import {
  flushMicrotasks,
  installTauriInternalsStub,
  uninstallTauriInternalsStub,
} from './testing/tauri-internals.stub';
import { TauriTranscriberAdapter } from './tauri-transcriber.adapter';

describe('TauriTranscriberAdapter', () => {
  let adapter: TauriTranscriberAdapter;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TauriTranscriberAdapter] });
    adapter = TestBed.inject(TauriTranscriberAdapter);
  });

  afterEach(() => uninstallTauriInternalsStub());

  it('partials() maps the transcript://partial event payload to the domain shape', async () => {
    const stub = installTauriInternalsStub((cmd) => {
      throw new Error(`unexpected command '${cmd}'`);
    });

    const results: unknown[] = [];
    adapter.partials().subscribe((partial) => results.push(partial));
    await flushMicrotasks();

    stub.emit('transcript://partial', { meetingId: 'm-1', text: 'partial text' });

    expect(results).toEqual([{ meetingId: toMeetingId('m-1'), text: 'partial text' }]);
  });

  it('finals() maps the snake_case segment inside transcript://final', async () => {
    const stub = installTauriInternalsStub((cmd) => {
      throw new Error(`unexpected command '${cmd}'`);
    });

    const results: unknown[] = [];
    adapter.finals().subscribe((final) => results.push(final));
    await flushMicrotasks();

    stub.emit('transcript://final', {
      meetingId: 'm-1',
      segment: { start_sec: 0, end_sec: 2, text: 'hello' },
    });

    expect(results).toEqual([
      { meetingId: toMeetingId('m-1'), segment: { startSec: 0, endSec: 2, text: 'hello' } },
    ]);
  });

  it('transcriptFor() maps a present TranscriptDto', async () => {
    let receivedArgs: unknown;
    installTauriInternalsStub((_cmd, args) => {
      receivedArgs = args;
      return { segments: [{ startSec: 0, endSec: 1, text: 'hi' }] };
    });

    const transcript = await adapter.transcriptFor(toMeetingId('m-1'));

    expect(receivedArgs).toEqual({ id: 'm-1' });
    expect(transcript).toEqual({ segments: [{ startSec: 0, endSec: 1, text: 'hi' }] });
  });

  it('transcriptFor() returns an empty transcript when the Rust side has none yet', async () => {
    installTauriInternalsStub(() => null);

    expect(await adapter.transcriptFor(toMeetingId('m-1'))).toEqual({ segments: [] });
  });
});
