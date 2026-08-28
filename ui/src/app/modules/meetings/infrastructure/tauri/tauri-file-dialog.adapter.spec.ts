import { TestBed } from '@angular/core/testing';

import { installTauriInternalsStub, uninstallTauriInternalsStub } from './testing/tauri-internals.stub';
import { TauriFileDialogAdapter } from './tauri-file-dialog.adapter';

describe('TauriFileDialogAdapter', () => {
  let adapter: TauriFileDialogAdapter;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TauriFileDialogAdapter] });
    adapter = TestBed.inject(TauriFileDialogAdapter);
  });

  afterEach(() => uninstallTauriInternalsStub());

  it('save() forwards a suggested filename and extension filter, and returns the chosen path', async () => {
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedArgs = args;
      expect(cmd).toBe('plugin:dialog|save');
      return '/Users/demo/meeting.md';
    });

    const path = await adapter.save('Weekly sync - 2026-08-25', 'md');

    expect(receivedArgs).toEqual({
      options: {
        defaultPath: 'Weekly sync - 2026-08-25.md',
        filters: [{ name: 'MD', extensions: ['md'] }],
      },
    });
    expect(path).toBe('/Users/demo/meeting.md');
  });

  it('save() returns null when the user cancels the dialog', async () => {
    installTauriInternalsStub(() => null);

    expect(await adapter.save('meeting', 'txt')).toBeNull();
  });
});
