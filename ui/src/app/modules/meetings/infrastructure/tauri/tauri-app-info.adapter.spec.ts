import { TestBed } from '@angular/core/testing';

import { installTauriInternalsStub, uninstallTauriInternalsStub } from './testing/tauri-internals.stub';
import { TauriAppInfoAdapter } from './tauri-app-info.adapter';

describe('TauriAppInfoAdapter', () => {
  let adapter: TauriAppInfoAdapter;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TauriAppInfoAdapter] });
    adapter = TestBed.inject(TauriAppInfoAdapter);
  });

  afterEach(() => uninstallTauriInternalsStub());

  it('version() invokes app_version and returns the raw string', async () => {
    let receivedCmd: string | undefined;
    installTauriInternalsStub((cmd) => {
      receivedCmd = cmd;
      return '0.3.1';
    });

    const version = await adapter.version();

    expect(receivedCmd).toBe('app_version');
    expect(version).toBe('0.3.1');
  });
});
