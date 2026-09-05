import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import {
  flushMicrotasks,
  installTauriInternalsStub,
  uninstallTauriInternalsStub,
} from './testing/tauri-internals.stub';
import { TauriRecorderAdapter } from './tauri-recorder.adapter';

// The stop-phase contract (stop/cancel acknowledgements, `recording://
// stop-progress`, `recording://completed`, `recording://health`) is specified
// in `tauri-recorder.adapter.stop-phase.spec.ts`, split out to keep this file
// under the project's max-lines limit.

describe('TauriRecorderAdapter', () => {
  let adapter: TauriRecorderAdapter;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TauriRecorderAdapter] });
    adapter = TestBed.inject(TauriRecorderAdapter);
  });

  afterEach(() => uninstallTauriInternalsStub());

  it('start() sends title and device, and maps the returned meeting', async () => {
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedArgs = args;
      expect(cmd).toBe('start_recording');
      return {
        id: 'm-1',
        title: 'Standup',
        createdAt: '2026-01-15T09:00:00Z',
        durationSec: 0,
        audioPath: null,
        transcript: null,
        summaries: [],
      };
    });

    const meeting = await adapter.start('Standup', 'Built-in Microphone');

    expect(receivedArgs).toEqual({ title: 'Standup', device: 'Built-in Microphone' });
    expect(meeting.title).toBe('Standup');
  });

  it('start() omits the device key when no device name is given', async () => {
    let receivedArgs: unknown;
    installTauriInternalsStub((_cmd, args) => {
      receivedArgs = args;
      return {
        id: 'm-1',
        title: 'Standup',
        createdAt: '2026-01-15T09:00:00Z',
        durationSec: 0,
        audioPath: null,
        transcript: null,
        summaries: [],
      };
    });

    await adapter.start('Standup');

    expect(receivedArgs).toEqual({ title: 'Standup' });
  });

  it('start() forwards the capture source when given', async () => {
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedArgs = args;
      expect(cmd).toBe('start_recording');
      return {
        id: 'm-1',
        title: 'Standup',
        createdAt: '2026-01-15T09:00:00Z',
        durationSec: 0,
        audioPath: null,
        transcript: null,
        summaries: [],
      };
    });

    await adapter.start('Standup', 'Built-in Microphone', 'mixed');

    expect(receivedArgs).toEqual({
      title: 'Standup',
      device: 'Built-in Microphone',
      source: 'mixed',
    });
  });

  it('start() forwards the system-audio source when given', async () => {
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedArgs = args;
      expect(cmd).toBe('start_recording');
      return {
        id: 'm-1',
        title: 'Standup',
        createdAt: '2026-01-15T09:00:00Z',
        durationSec: 0,
        audioPath: null,
        transcript: null,
        summaries: [],
      };
    });

    await adapter.start('Standup', 'Built-in Microphone', 'mixed', 'app:teams');

    expect(receivedArgs).toEqual({
      title: 'Standup',
      device: 'Built-in Microphone',
      source: 'mixed',
      systemSource: 'app:teams',
    });
  });

  it('state() maps the recording state payload into a snapshot', async () => {
    installTauriInternalsStub(() => ({
      meetingId: 'm-1',
      state: 'recording',
      effectiveSystemSource: null,
      elapsedSec: 42.5,
    }));

    expect(await adapter.state()).toEqual({
      state: 'recording',
      meetingId: toMeetingId('m-1'),
      elapsedSec: 42.5,
    });
  });

  it('state() reports a null meetingId/elapsedSec when idle', async () => {
    installTauriInternalsStub(() => ({
      meetingId: null,
      state: 'idle',
      effectiveSystemSource: null,
      elapsedSec: null,
    }));

    expect(await adapter.state()).toEqual({ state: 'idle', meetingId: null, elapsedSec: null });
  });

  it('levels() maps the recording://level event stream', async () => {
    const stub = installTauriInternalsStub((cmd) => {
      throw new Error(`unexpected command '${cmd}'`);
    });

    const results: unknown[] = [];
    adapter.levels().subscribe((level) => results.push(level));
    await flushMicrotasks();

    stub.emit('recording://level', { rms: 0.4, dbfs: -8 });

    expect(results).toEqual([{ rms: 0.4, dbfs: -8 }]);
  });

  it('stateChanges() extracts state from the recording://state event stream', async () => {
    const stub = installTauriInternalsStub((cmd) => {
      throw new Error(`unexpected command '${cmd}'`);
    });

    const results: unknown[] = [];
    adapter.stateChanges().subscribe((state) => results.push(state));
    await flushMicrotasks();

    stub.emit('recording://state', { meetingId: null, state: 'idle' });

    expect(results).toEqual(['idle']);
  });

  it('effectiveSystemSourceChanges() maps the effectiveSystemSource field from the recording://state event stream', async () => {
    const stub = installTauriInternalsStub((cmd) => {
      throw new Error(`unexpected command '${cmd}'`);
    });

    const results: unknown[] = [];
    adapter.effectiveSystemSourceChanges().subscribe((source) => results.push(source));
    await flushMicrotasks();

    stub.emit('recording://state', {
      meetingId: 'm-1',
      state: 'recording',
      effectiveSystemSource: { id: 'app:teams', name: 'Teams' },
    });
    stub.emit('recording://state', { meetingId: null, state: 'idle', effectiveSystemSource: null });

    expect(results).toEqual([{ id: 'app:teams', name: 'Teams' }, null]);
  });

  it('effectiveSystemSourceChanges() maps a follow-up state event that resolves the source after the initial null', async () => {
    const stub = installTauriInternalsStub((cmd) => {
      throw new Error(`unexpected command '${cmd}'`);
    });

    const results: unknown[] = [];
    adapter.effectiveSystemSourceChanges().subscribe((source) => results.push(source));
    await flushMicrotasks();

    // The initial recording://state event: the capture backend hasn't
    // resolved the system source yet.
    stub.emit('recording://state', { meetingId: 'm-1', state: 'recording', effectiveSystemSource: null });
    // The worker's follow-up event once the system-audio tap is live.
    stub.emit('recording://state', {
      meetingId: 'm-1',
      state: 'recording',
      effectiveSystemSource: { id: 'app:teams', name: 'Teams' },
    });

    expect(results).toEqual([null, { id: 'app:teams', name: 'Teams' }]);
  });

  it('listDevices() maps every DeviceInfoDto to an AudioDevice', async () => {
    installTauriInternalsStub(() => [{ name: 'Built-in Microphone' }]);

    expect(await adapter.listDevices()).toEqual([{ name: 'Built-in Microphone' }]);
  });

  it('listAudioSources() maps every AudioSourceDto to an AudioSource, led by the all-output source', async () => {
    let receivedCmd: string | undefined;
    installTauriInternalsStub((cmd) => {
      receivedCmd = cmd;
      return [
        { id: 'system:all', name: 'All system audio' },
        { id: 'app:teams', name: 'Teams' },
      ];
    });

    expect(await adapter.listAudioSources()).toEqual([
      { id: 'system:all', name: 'All system audio' },
      { id: 'app:teams', name: 'Teams' },
    ]);
    expect(receivedCmd).toBe('list_audio_sources');
  });

  it('defaultDevice() maps the single DeviceInfoDto to an AudioDevice', async () => {
    installTauriInternalsStub(() => ({ name: 'Built-in Microphone' }));

    expect(await adapter.defaultDevice()).toEqual({ name: 'Built-in Microphone' });
  });

  it('systemAudioStatus() returns the status payload verbatim', async () => {
    let receivedCmd: string | undefined;
    installTauriInternalsStub((cmd) => {
      receivedCmd = cmd;
      return { kind: 'permission_denied', restartRequired: true };
    });

    expect(await adapter.systemAudioStatus()).toEqual({
      kind: 'permission_denied',
      restartRequired: true,
    });
    expect(receivedCmd).toBe('system_audio_status');
  });

  it('requestSystemAudioPermission() returns the status payload verbatim', async () => {
    let receivedCmd: string | undefined;
    installTauriInternalsStub((cmd) => {
      receivedCmd = cmd;
      return { kind: 'available' };
    });

    expect(await adapter.requestSystemAudioPermission()).toEqual({ kind: 'available' });
    expect(receivedCmd).toBe('request_system_audio_permission');
  });
});
