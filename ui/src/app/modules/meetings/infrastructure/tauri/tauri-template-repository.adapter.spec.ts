import { TestBed } from '@angular/core/testing';

import { installTauriInternalsStub, uninstallTauriInternalsStub } from './testing/tauri-internals.stub';
import { TauriTemplateRepositoryAdapter } from './tauri-template-repository.adapter';

describe('TauriTemplateRepositoryAdapter', () => {
  let adapter: TauriTemplateRepositoryAdapter;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TauriTemplateRepositoryAdapter] });
    adapter = TestBed.inject(TauriTemplateRepositoryAdapter);
  });

  afterEach(() => uninstallTauriInternalsStub());

  it('list() maps every TemplateDto, dropping the unmappable section_schema', async () => {
    let receivedCmd: string | undefined;
    installTauriInternalsStub((cmd) => {
      receivedCmd = cmd;
      return [
        {
          name: 'key-points',
          description: 'Extract key points.',
          prompt: 'Summarize: {transcript}',
          section_schema: { type: 'object' },
        },
      ];
    });

    const templates = await adapter.list();

    expect(receivedCmd).toBe('list_templates');
    expect(templates).toEqual([
      { name: 'key-points', description: 'Extract key points.', prompt: 'Summarize: {transcript}' },
    ]);
  });
});
