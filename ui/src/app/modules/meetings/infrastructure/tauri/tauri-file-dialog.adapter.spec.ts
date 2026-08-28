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

  it('open() forwards the given filters and returns the chosen path', async () => {
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedArgs = args;
      expect(cmd).toBe('plugin:dialog|open');
      return '/Users/demo/recording.m4a';
    });

    const path = await adapter.open([{ name: 'Audio', extensions: ['wav', 'm4a', 'mp3'] }]);

    expect(receivedArgs).toEqual({
      options: {
        multiple: false,
        directory: false,
        filters: [{ name: 'Audio', extensions: ['wav', 'm4a', 'mp3'] }],
      },
    });
    expect(path).toBe('/Users/demo/recording.m4a');
  });

  it('open() returns null when the user cancels the dialog', async () => {
    installTauriInternalsStub(() => null);

    expect(await adapter.open([{ name: 'Audio', extensions: ['wav'] }])).toBeNull();
  });

  it('open() normalizes an array result to its first entry', async () => {
    installTauriInternalsStub(() => ['/Users/demo/a.wav', '/Users/demo/b.wav']);

    expect(await adapter.open([{ name: 'Audio', extensions: ['wav'] }])).toBe('/Users/demo/a.wav');
  });
});
