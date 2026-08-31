import { TestBed } from '@angular/core/testing';

import { toFolderId } from '../../core/models/folder.model';
import { AudioImportPort } from '../../core/ports/audio-import.port';
import { PreferencesPort } from '../../core/ports/preferences.port';
import { RecorderPort } from '../../core/ports/recorder.port';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import { InMemoryAudioImportFake } from '../testing/in-memory-audio-import.fake';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { InMemoryTranscriberFake } from '../testing/in-memory-transcriber.fake';
import { EXPANDED_FOLDERS_PREFERENCE_KEY, MeetingsStore } from './meetings.store';

describe('MeetingsStore folders', () => {
  let store: MeetingsStore;
  let preferences: InMemoryPreferencesFake;

  const configureStore = (sharedPreferences?: InMemoryPreferencesFake) => {
    TestBed.configureTestingModule({
      providers: [
        MeetingsStore,
        InMemoryRecorderFake,
        { provide: RecorderPort, useExisting: InMemoryRecorderFake },
        InMemoryTranscriberFake,
        { provide: TranscriberPort, useExisting: InMemoryTranscriberFake },
        { provide: SummarizerPort, useClass: InMemorySummarizerFake },
        InMemoryAudioImportFake,
        { provide: AudioImportPort, useExisting: InMemoryAudioImportFake },
        sharedPreferences
          ? { provide: PreferencesPort, useValue: sharedPreferences }
          : { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
      ],
    });
  };

  beforeEach(() => {
    configureStore();
    store = TestBed.inject(MeetingsStore);
    preferences = TestBed.inject(PreferencesPort) as InMemoryPreferencesFake;
  });

  it('starts with an empty folders list and no expanded folders', () => {
    // Assert
    expect(store.folders()).toEqual([]);
    expect(store.expandedFolders()).toEqual(new Set());
  });

  it('setFolders / addFolder / updateFolder / removeFolder produce new arrays and never mutate the previous value', () => {
    // Arrange
    const folderA = { id: toFolderId('f-1'), name: 'Work', createdAt: new Date(), position: 0 };
    const folderB = { id: toFolderId('f-2'), name: 'Personal', createdAt: new Date(), position: 1 };

    // Act & Assert: setFolders
    const beforeSet = store.folders();
    store.setFolders([folderA]);
    expect(store.folders()).not.toBe(beforeSet);
    expect(store.folders()).toEqual([folderA]);

    // Act & Assert: addFolder
    const beforeAdd = store.folders();
    store.addFolder(folderB);
    expect(store.folders()).not.toBe(beforeAdd);
    expect(store.folders()).toEqual([folderA, folderB]);

    // Act & Assert: updateFolder
    const renamed = { ...folderA, name: 'Work renamed' };
    const beforeUpdate = store.folders();
    store.updateFolder(renamed);
    expect(store.folders()).not.toBe(beforeUpdate);
    expect(store.folders().find((folder) => folder.id === folderA.id)?.name).toBe('Work renamed');

    // Act & Assert: removeFolder
    const beforeRemove = store.folders();
    store.removeFolder(folderB.id);
    expect(store.folders()).not.toBe(beforeRemove);
    expect(store.folders().map((folder) => folder.id)).toEqual([folderA.id]);
  });

  it('removeFolder also drops the id from EXPANDED_FOLDERS', () => {
    // Arrange
    const folder = { id: toFolderId('f-1'), name: 'Work', createdAt: new Date(), position: 0 };
    store.setFolders([folder]);
    store.toggleFolderExpanded(folder.id);
    expect(store.expandedFolders().has(folder.id)).toBe(true);

    // Act
    store.removeFolder(folder.id);

    // Assert
    expect(store.expandedFolders().has(folder.id)).toBe(false);
  });

  it('toggleFolderExpanded persists via PreferencesPort and the state survives a store rebuild', () => {
    // Arrange
    const folder = { id: toFolderId('f-1'), name: 'Work', createdAt: new Date(), position: 0 };
    store.setFolders([folder]);

    // Act
    store.toggleFolderExpanded(folder.id);

    // Assert
    expect(store.expandedFolders().has(folder.id)).toBe(true);
    expect(JSON.parse(preferences.get(EXPANDED_FOLDERS_PREFERENCE_KEY) ?? '[]')).toEqual([folder.id]);

    TestBed.resetTestingModule();
    configureStore(preferences);
    const rebuiltStore = TestBed.inject(MeetingsStore);

    expect(rebuiltStore.expandedFolders().has(folder.id)).toBe(true);
  });

  it('toggleFolderExpanded collapses an already-expanded folder and persists the removal', () => {
    // Arrange
    const folder = { id: toFolderId('f-1'), name: 'Work', createdAt: new Date(), position: 0 };
    store.setFolders([folder]);
    store.toggleFolderExpanded(folder.id);

    // Act
    store.toggleFolderExpanded(folder.id);

    // Assert
    expect(store.expandedFolders().has(folder.id)).toBe(false);
    expect(JSON.parse(preferences.get(EXPANDED_FOLDERS_PREFERENCE_KEY) ?? '[]')).toEqual([]);
  });
});
