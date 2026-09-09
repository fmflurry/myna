import { TestBed } from '@angular/core/testing';

import { MeetingsError } from '../../core/models/recording-state.model';
import { installTauriInternalsStub, uninstallTauriInternalsStub } from './testing/tauri-internals.stub';
import { TauriStorageLocationAdapter } from './tauri-storage-location.adapter';

/**
 * Pins the storage-location IPC mapping: `get`/`set`/`reset` reach the
 * runtime exclusively through `invokeCommand` (frozen command names +
 * args), and the `set`/`reset` DTOs map onto the domain `StorageLocation`.
 */
describe('TauriStorageLocationAdapter', () => {
  let adapter: TauriStorageLocationAdapter;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TauriStorageLocationAdapter] });
    adapter = TestBed.inject(TauriStorageLocationAdapter);
  });

  afterEach(() => uninstallTauriInternalsStub());

  it('get() invokes get_storage_location with no args and returns the path', async () => {
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return '/tmp/myna-data';
    });

    const path = await adapter.get();

    expect(receivedCmd).toBe('get_storage_location');
    expect(receivedArgs).toEqual({});
    expect(path).toBe('/tmp/myna-data');
  });

  it('set() invokes set_storage_location with the path and maps the DTO', async () => {
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return { path: '/tmp/new-root', restartRequired: true };
    });

    const location = await adapter.set('/tmp/new-root');

    expect(receivedCmd).toBe('set_storage_location');
    expect(receivedArgs).toEqual({ path: '/tmp/new-root' });
    expect(location).toEqual({ path: '/tmp/new-root', restartRequired: true });
  });

  it('set() maps a no-restart DTO without inventing a restart', async () => {
    installTauriInternalsStub(() => ({ path: '/tmp/myna-data', restartRequired: false }));

    const location = await adapter.set('/tmp/myna-data');

    expect(location).toEqual({ path: '/tmp/myna-data', restartRequired: false });
  });

  it('reset() invokes reset_storage_location with no args and maps the DTO', async () => {
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return { path: '/tmp/myna-data', restartRequired: true };
    });

    const location = await adapter.reset();

    expect(receivedCmd).toBe('reset_storage_location');
    expect(receivedArgs).toEqual({});
    expect(location).toEqual({ path: '/tmp/myna-data', restartRequired: true });
  });

  it('set(path, true) wires moveExisting true (move)', async () => {
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      expect(cmd).toBe('set_storage_location');
      receivedArgs = args;
      return { path: '/tmp/new-root', restartRequired: true };
    });

    const location = await adapter.set('/tmp/new-root', true);

    expect(receivedArgs).toEqual({ path: '/tmp/new-root', moveExisting: true });
    expect(location).toEqual({ path: '/tmp/new-root', restartRequired: true });
  });

  it('set(path, false) wires moveExisting false (stay)', async () => {
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      expect(cmd).toBe('set_storage_location');
      receivedArgs = args;
      return { path: '/tmp/stay-root', restartRequired: true };
    });

    const location = await adapter.set('/tmp/stay-root', false);

    expect(receivedArgs).toEqual({ path: '/tmp/stay-root', moveExisting: false });
    expect(location).toEqual({ path: '/tmp/stay-root', restartRequired: true });
  });

  it('reset(true) wires moveExisting true (move)', async () => {
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      expect(cmd).toBe('reset_storage_location');
      receivedArgs = args;
      return { path: '/tmp/myna-data', restartRequired: true };
    });

    const location = await adapter.reset(true);

    expect(receivedArgs).toEqual({ moveExisting: true });
    expect(location).toEqual({ path: '/tmp/myna-data', restartRequired: true });
  });

  it('reset(false) wires moveExisting false (stay)', async () => {
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      expect(cmd).toBe('reset_storage_location');
      receivedArgs = args;
      return { path: '/tmp/myna-data', restartRequired: true };
    });

    const location = await adapter.reset(false);

    expect(receivedArgs).toEqual({ moveExisting: false });
    expect(location).toEqual({ path: '/tmp/myna-data', restartRequired: true });
  });

  it('omits moveExisting when the flag is undefined so Rust defaults to move', async () => {
    const received: unknown[] = [];
    installTauriInternalsStub((cmd, args) => {
      received.push({ cmd, args });
      return cmd === 'get_storage_location' ? '/tmp/myna-data' : { path: '/tmp/myna-data', restartRequired: false };
    });

    await adapter.set('/tmp/myna-data');
    await adapter.reset();

    expect(received[0]).toEqual({ cmd: 'set_storage_location', args: { path: '/tmp/myna-data' } });
    expect(received[1]).toEqual({ cmd: 'reset_storage_location', args: {} });
    expect('moveExisting' in (received[0] as { args: object }).args).toBe(false);
    expect('moveExisting' in (received[1] as { args: object }).args).toBe(false);
  });

  it('propagates a Rust rejection instead of returning a guessed location', async () => {
    installTauriInternalsStub(() => {
      throw { code: 'PATH', message: 'not a directory' };
    });

    let caught: unknown;
    try {
      await adapter.set('/dev/null');
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof MeetingsError).toBe(true);
    if (caught instanceof MeetingsError) {
      expect(caught.code).toBe('PATH');
      expect(caught.message).toBe('not a directory');
    }
  });
});
