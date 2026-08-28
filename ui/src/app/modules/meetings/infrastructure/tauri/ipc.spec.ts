import { MeetingsError } from '../../core/models/recording-state.model';
import { invokeCommand, mapIpcError, onEvent } from './ipc';
import {
  flushMicrotasks,
  installTauriInternalsStub,
  uninstallTauriInternalsStub,
} from './testing/tauri-internals.stub';

describe('mapIpcError', () => {
  it('narrows a known Rust error envelope into a MeetingsError carrying the code', () => {
    const mapped = mapIpcError({ code: 'NOT_FOUND', message: 'meeting missing' });

    expect(mapped).toBeInstanceOf(MeetingsError);
    expect(mapped).toBeInstanceOf(Error);
    expect(mapped.code).toBe('NOT_FOUND');
    expect(mapped.message).toBe('meeting missing');
  });

  it('falls back to UNKNOWN for an unrecognized code', () => {
    const mapped = mapIpcError({ code: 'SOMETHING_NEW', message: 'oops' });

    expect(mapped.code).toBe('UNKNOWN');
    expect(mapped.message).toBe('oops');
  });

  it('falls back to UNKNOWN for a native Error', () => {
    const mapped = mapIpcError(new Error('boom'));

    expect(mapped.code).toBe('UNKNOWN');
    expect(mapped.message).toBe('boom');
  });

  it('falls back to UNKNOWN for a bare string rejection', () => {
    const mapped = mapIpcError('plain string failure');

    expect(mapped.code).toBe('UNKNOWN');
    expect(mapped.message).toBe('plain string failure');
  });
});

describe('invokeCommand', () => {
  afterEach(() => uninstallTauriInternalsStub());

  it('resolves with the value the Rust command returns', async () => {
    installTauriInternalsStub((cmd) => {
      if (cmd === 'default_input_device') return { name: 'Built-in Microphone' };
      throw new Error(`unexpected command '${cmd}'`);
    });

    const result = await invokeCommand('default_input_device', {});

    expect(result).toEqual({ name: 'Built-in Microphone' });
  });

  it('rejects with a mapped MeetingsError when the Rust command rejects', async () => {
    installTauriInternalsStub((cmd) => {
      if (cmd === 'start_recording') throw { code: 'BUSY', message: 'already recording' };
      throw new Error(`unexpected command '${cmd}'`);
    });

    let caught: unknown;
    try {
      await invokeCommand('start_recording', { title: 'Standup' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MeetingsError);
    expect((caught as MeetingsError).code).toBe('BUSY');
    expect((caught as MeetingsError).message).toBe('already recording');
  });
});

describe('onEvent', () => {
  afterEach(() => uninstallTauriInternalsStub());

  it('emits every payload the Rust core pushes on the event', async () => {
    const stub = installTauriInternalsStub((cmd) => {
      throw new Error(`unexpected command '${cmd}'`);
    });

    const received: unknown[] = [];
    const subscription = onEvent('recording://level').subscribe((payload) => received.push(payload));
    await flushMicrotasks();

    stub.emit('recording://level', { rms: 0.5, dbfs: -6 });

    expect(received).toEqual([{ rms: 0.5, dbfs: -6 }]);
    subscription.unsubscribe();
  });

  it('calls plugin:event|unlisten on teardown', async () => {
    const stub = installTauriInternalsStub((cmd) => {
      throw new Error(`unexpected command '${cmd}'`);
    });

    const subscription = onEvent('recording://state').subscribe();
    await flushMicrotasks();

    subscription.unsubscribe();
    await flushMicrotasks();

    const unlistenCall = stub.invokeSpy.mock.calls.find(([cmd]) => cmd === 'plugin:event|unlisten');
    expect(unlistenCall).toBeDefined();
  });
});
