import { TestBed } from '@angular/core/testing';

import { PreferencesPort } from '../../core/ports/preferences.port';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { UpdatesStore } from './updates.store';

describe('UpdatesStore installState', () => {
  let store: UpdatesStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        UpdatesStore,
        { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
      ],
    });
    store = TestBed.inject(UpdatesStore);
  });

  it('starts idle', () => {
    expect(store.installState()).toEqual({ status: 'idle' });
  });

  it('applies every install-state variant via setInstallState', () => {
    store.setInstallState({ status: 'downloading', percent: 42 });
    expect(store.installState()).toEqual({ status: 'downloading', percent: 42 });

    store.setInstallState({ status: 'ready', version: '1.0.0' });
    expect(store.installState()).toEqual({ status: 'ready', version: '1.0.0' });

    store.setInstallState({ status: 'failed', message: 'disk full' });
    expect(store.installState()).toEqual({ status: 'failed', message: 'disk full' });

    store.setInstallState({ status: 'idle' });
    expect(store.installState()).toEqual({ status: 'idle' });
  });
});
