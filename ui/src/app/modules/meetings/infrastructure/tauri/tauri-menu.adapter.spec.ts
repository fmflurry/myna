import { TestBed } from '@angular/core/testing';

import {
  flushMicrotasks,
  installTauriInternalsStub,
  uninstallTauriInternalsStub,
} from './testing/tauri-internals.stub';
import { TauriMenuAdapter } from './tauri-menu.adapter';

describe('TauriMenuAdapter', () => {
  let adapter: TauriMenuAdapter;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TauriMenuAdapter] });
    adapter = TestBed.inject(TauriMenuAdapter);
  });

  afterEach(() => uninstallTauriInternalsStub());

  it('emits on every menu://settings event (null wire payload mapped to undefined)', async () => {
    const stub = installTauriInternalsStub((cmd) => {
      throw new Error(`unexpected command '${cmd}'`);
    });

    const results: unknown[] = [];
    const subscription = adapter.settingsRequests().subscribe(() => results.push(undefined));
    await flushMicrotasks();

    stub.emit('menu://settings', null);
    stub.emit('menu://settings', null);

    expect(results).toEqual([undefined, undefined]);
    subscription.unsubscribe();
  });

  it('unlistens the menu://settings listener on teardown', async () => {
    const stub = installTauriInternalsStub((cmd) => {
      throw new Error(`unexpected command '${cmd}'`);
    });

    const subscription = adapter.settingsRequests().subscribe(() => undefined);
    await flushMicrotasks();

    subscription.unsubscribe();

    const unlistenCalls = stub.invokeSpy.mock.calls.filter(([cmd]) => cmd === 'plugin:event|unlisten');
    expect(unlistenCalls.length).toBe(1);
  });
});
