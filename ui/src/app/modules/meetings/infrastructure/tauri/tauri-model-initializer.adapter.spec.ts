import { TestBed } from '@angular/core/testing';

import {
  flushMicrotasks,
  installTauriInternalsStub,
  uninstallTauriInternalsStub,
} from './testing/tauri-internals.stub';
import { TauriModelInitializerAdapter } from './tauri-model-initializer.adapter';

describe('TauriModelInitializerAdapter', () => {
  let adapter: TauriModelInitializerAdapter;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TauriModelInitializerAdapter] });
    adapter = TestBed.inject(TauriModelInitializerAdapter);
  });

  afterEach(() => uninstallTauriInternalsStub());

  it('start() invokes start_model_download with no arguments', async () => {
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return undefined;
    });

    await adapter.start();

    expect(receivedCmd).toBe('start_model_download');
    expect(receivedArgs).toEqual({});
  });

  it('cancel() invokes cancel_model_download with no arguments', async () => {
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return undefined;
    });

    await adapter.cancel();

    expect(receivedCmd).toBe('cancel_model_download');
    expect(receivedArgs).toEqual({});
  });

  it('progress() maps the models://progress event payload to the domain shape', async () => {
    const stub = installTauriInternalsStub((cmd) => {
      throw new Error(`unexpected command '${cmd}'`);
    });

    const results: unknown[] = [];
    adapter.progress().subscribe((progress) => results.push(progress));
    await flushMicrotasks();

    stub.emit('models://progress', { artifact: 'parakeet', index: 0, total: 3 });
    stub.emit('models://progress', { artifact: 'qwen', index: 1, total: 3 });

    expect(results).toEqual([
      { artifact: 'parakeet', index: 0, total: 3 },
      { artifact: 'qwen', index: 1, total: 3 },
    ]);
  });

  it('done() maps the models://done event payload to the domain shape', async () => {
    const stub = installTauriInternalsStub((cmd) => {
      throw new Error(`unexpected command '${cmd}'`);
    });

    const results: unknown[] = [];
    adapter.done().subscribe((done) => results.push(done));
    await flushMicrotasks();

    stub.emit('models://done', { success: false, cancelled: true, message: null });
    stub.emit('models://done', { success: true, cancelled: false, message: null });

    expect(results).toEqual([
      { success: false, cancelled: true, message: null },
      { success: true, cancelled: false, message: null },
    ]);
  });

  it('unlistens both event streams on teardown', async () => {
    const stub = installTauriInternalsStub((cmd) => {
      throw new Error(`unexpected command '${cmd}'`);
    });

    const progressSubscription = adapter.progress().subscribe(() => undefined);
    const doneSubscription = adapter.done().subscribe(() => undefined);
    await flushMicrotasks();

    progressSubscription.unsubscribe();
    doneSubscription.unsubscribe();

    const unlistenCalls = stub.invokeSpy.mock.calls.filter(([cmd]) => cmd === 'plugin:event|unlisten');
    expect(unlistenCalls.length).toBe(2);
  });
});
