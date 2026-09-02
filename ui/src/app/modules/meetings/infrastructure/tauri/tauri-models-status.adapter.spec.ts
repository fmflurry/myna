import { TestBed } from '@angular/core/testing';

import { installTauriInternalsStub, uninstallTauriInternalsStub } from './testing/tauri-internals.stub';
import { TauriModelsStatusAdapter } from './tauri-models-status.adapter';

describe('TauriModelsStatusAdapter', () => {
  let adapter: TauriModelsStatusAdapter;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TauriModelsStatusAdapter] });
    adapter = TestBed.inject(TauriModelsStatusAdapter);
  });

  afterEach(() => uninstallTauriInternalsStub());

  it('status() maps the ModelsStatusDto to the domain shape', async () => {
    installTauriInternalsStub(() => ({
      parakeet: { present: true, path: '/models/parakeet', expectedFiles: ['a'] },
      qwen: { present: true, path: '/models/qwen', expectedFiles: ['b'] },
      silero: { present: true, path: '/models/silero', expectedFiles: ['c'] },
      allPresent: true,
    }));

    const status = await adapter.status();

    expect(status.allPresent).toBe(true);
    expect(status.parakeet).toEqual({ present: true, path: '/models/parakeet', expectedFiles: ['a'] });
  });
});
