import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { AppInfoPort } from '../../core/ports/app-info.port';
import { FileDialogPort } from '../../core/ports/file-dialog.port';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';
import { ModelsStatusPort } from '../../core/ports/models-status.port';
import { PreferencesPort } from '../../core/ports/preferences.port';
import { RecorderPort } from '../../core/ports/recorder.port';
import { StorageLocationPort } from '../../core/ports/storage-location.port';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { TemplateRepositoryPort } from '../../core/ports/template-repository.port';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import { provideMeetings } from '../../meetings.providers';
import { InMemoryAppInfoFake } from '../testing/in-memory-app-info.fake';
import { InMemoryFileDialogFake } from '../testing/in-memory-file-dialog.fake';
import { InMemoryMeetingRepositoryFake } from '../testing/in-memory-meeting-repository.fake';
import { InMemoryModelsStatusFake } from '../testing/in-memory-models-status.fake';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { InMemoryStorageLocationFake } from '../testing/in-memory-storage-location.fake';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { InMemoryTemplateRepositoryFake } from '../testing/in-memory-template-repository.fake';
import { InMemoryTranscriberFake } from '../testing/in-memory-transcriber.fake';
import { MeetingsFacade } from './meetings.facade';

const FAKE_PORT_OVERRIDES = [
  { provide: MeetingRepositoryPort, useClass: InMemoryMeetingRepositoryFake },
  { provide: RecorderPort, useClass: InMemoryRecorderFake },
  InMemorySummarizerFake,
  { provide: SummarizerPort, useExisting: InMemorySummarizerFake },
  { provide: TranscriberPort, useClass: InMemoryTranscriberFake },
  { provide: TemplateRepositoryPort, useClass: InMemoryTemplateRepositoryFake },
  { provide: ModelsStatusPort, useClass: InMemoryModelsStatusFake },
  { provide: FileDialogPort, useClass: InMemoryFileDialogFake },
  { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
  { provide: AppInfoPort, useClass: InMemoryAppInfoFake },
  { provide: StorageLocationPort, useClass: InMemoryStorageLocationFake },
];

/**
 * Covers the storage-location facade surface: `loadStorageLocation` seeds
 * the slot with `restartRequired: false`, `set`/`reset` write the slot ONLY
 * after the port write succeeds — a rejected move leaves the previous
 * location on screen for retry and funnels into `error()`.
 */
describe('MeetingsFacade storage location', () => {
  let facade: MeetingsFacade;
  let storage: InMemoryStorageLocationFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideMeetings(), ...FAKE_PORT_OVERRIDES],
    });
    facade = TestBed.inject(MeetingsFacade);
    storage = TestBed.inject(StorageLocationPort) as InMemoryStorageLocationFake;
  });

  afterEach(() => vi.restoreAllMocks());

  it('storageLocation is undefined until loadStorageLocation runs', () => {
    expect(facade.storageLocation()).toBeUndefined();
  });

  it('loadStorageLocation populates the slot with restartRequired false', async () => {
    storage.seed({ path: '/tmp/seeded-root', restartRequired: true });

    await facade.loadStorageLocation();

    expect(facade.storageLocation()).toEqual({ path: '/tmp/seeded-root', restartRequired: false });
    expect(facade.error()).toBeUndefined();
  });

  it('setStorageLocation writes the slot on success, carrying restartRequired', async () => {
    await facade.loadStorageLocation();

    await facade.setStorageLocation('/tmp/new-root');

    expect(facade.storageLocation()).toEqual({ path: '/tmp/new-root', restartRequired: true });
    expect(facade.error()).toBeUndefined();
  });

  it('a failed set leaves the previous location untouched and reports the error', async () => {
    await facade.loadStorageLocation();
    const before = facade.storageLocation();
    vi.spyOn(storage, 'set').mockRejectedValueOnce(new Error('busy'));

    await facade.setStorageLocation('/tmp/rejected-root');

    expect(facade.storageLocation()).toEqual(before);
    expect(facade.error()).toBeDefined();
    expect(facade.error()?.source).toBe('setStorageLocation');
  });

  it('resetStorageLocation moves back to the default root on success', async () => {
    await facade.loadStorageLocation();
    await facade.setStorageLocation('/tmp/new-root');

    await facade.resetStorageLocation();

    expect(facade.storageLocation()?.path).toBe('/tmp/myna-data');
    expect(facade.error()).toBeUndefined();
  });

  it('a failed reset leaves the previous location untouched and reports the error', async () => {
    await facade.loadStorageLocation();
    await facade.setStorageLocation('/tmp/new-root');
    const before = facade.storageLocation();
    vi.spyOn(storage, 'reset').mockRejectedValueOnce(new Error('busy'));

    await facade.resetStorageLocation();

    expect(facade.storageLocation()).toEqual(before);
    expect(facade.error()).toBeDefined();
    expect(facade.error()?.source).toBe('resetStorageLocation');
  });
});
