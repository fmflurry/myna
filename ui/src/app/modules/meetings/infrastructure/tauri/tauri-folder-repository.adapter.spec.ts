import { TestBed } from '@angular/core/testing';

import { toFolderId } from '../../core/models/folder.model';
import { installTauriInternalsStub, uninstallTauriInternalsStub } from './testing/tauri-internals.stub';
import { TauriFolderRepositoryAdapter } from './tauri-folder-repository.adapter';

describe('TauriFolderRepositoryAdapter', () => {
  let adapter: TauriFolderRepositoryAdapter;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TauriFolderRepositoryAdapter] });
    adapter = TestBed.inject(TauriFolderRepositoryAdapter);
  });

  afterEach(() => uninstallTauriInternalsStub());

  it('list() invokes list_folders with no arguments and maps every returned FolderDto', async () => {
    // Arrange
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return [{ id: 'f-1', name: 'Work', createdAt: '2026-01-15T09:00:00Z', position: 0 }];
    });

    // Act
    const folders = await adapter.list();

    // Assert
    expect(receivedCmd).toBe('list_folders');
    expect(receivedArgs).toEqual({});
    expect(folders.length).toBe(1);
    expect(folders[0]?.name).toBe('Work');
  });

  it('create() invokes create_folder with { name } and maps the returned FolderDto', async () => {
    // Arrange
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return { id: 'f-2', name: 'Personal', createdAt: '2026-01-15T09:00:00Z', position: 1 };
    });

    // Act
    const folder = await adapter.create('Personal');

    // Assert
    expect(receivedCmd).toBe('create_folder');
    expect(receivedArgs).toEqual({ name: 'Personal' });
    expect(folder.name).toBe('Personal');
  });

  it('rename() invokes rename_folder with { folderId, name } and maps the returned FolderDto', async () => {
    // Arrange
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return { id: 'f-1', name: 'Renamed', createdAt: '2026-01-15T09:00:00Z', position: 0 };
    });

    // Act
    const folder = await adapter.rename(toFolderId('f-1'), 'Renamed');

    // Assert
    expect(receivedCmd).toBe('rename_folder');
    expect(receivedArgs).toEqual({ folderId: 'f-1', name: 'Renamed' });
    expect(folder.name).toBe('Renamed');
  });

  it('delete() invokes delete_folder with { folderId }', async () => {
    // Arrange
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return undefined;
    });

    // Act
    await adapter.delete(toFolderId('f-1'));

    // Assert
    expect(receivedCmd).toBe('delete_folder');
    expect(receivedArgs).toEqual({ folderId: 'f-1' });
  });
});
