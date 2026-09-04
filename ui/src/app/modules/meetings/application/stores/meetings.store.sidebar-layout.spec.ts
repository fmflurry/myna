import { TestBed } from '@angular/core/testing';

import { PreferencesPort } from '../../core/ports/preferences.port';
import { RecorderPort } from '../../core/ports/recorder.port';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { InMemoryTranscriberFake } from '../testing/in-memory-transcriber.fake';
import {
  MeetingsStore,
  SIDEBAR_COLLAPSED_PREFERENCE_KEY,
  SIDEBAR_WIDTH_PREFERENCE_KEY,
} from './meetings.store';

describe('MeetingsStore — sidebar layout', () => {
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

  it('defaults the sidebar width to 224px and the sidebar to expanded when nothing is stored', () => {
    expect(store.sidebarWidth()).toBe(224);
    expect(store.sidebarCollapsed()).toBe(false);
  });

  it('reflects setSidebarWidth and persists it via PreferencesPort', () => {
    store.setSidebarWidth(300);

    expect(store.sidebarWidth()).toBe(300);
    expect(preferences.get(SIDEBAR_WIDTH_PREFERENCE_KEY)).toBe('300');
  });

  it('clamps an out-of-range sidebar width before storing or applying it', () => {
    store.setSidebarWidth(900);
    expect(store.sidebarWidth()).toBe(480);

    store.setSidebarWidth(10);
    expect(store.sidebarWidth()).toBe(200);
  });

  it('reads a stored sidebar width back across a store rebuild', () => {
    store.setSidebarWidth(320);
    TestBed.resetTestingModule();
    configureStore(preferences);
    const rebuiltStore = TestBed.inject(MeetingsStore);

    expect(rebuiltStore.sidebarWidth()).toBe(320);
  });

  it('falls back to the default sidebar width when the stored preference is not a usable number', () => {
    preferences.set(SIDEBAR_WIDTH_PREFERENCE_KEY, 'not-a-number');
    TestBed.resetTestingModule();
    configureStore(preferences);
    const rebuiltStore = TestBed.inject(MeetingsStore);

    expect(rebuiltStore.sidebarWidth()).toBe(224);
  });

  it('reflects setSidebarCollapsed and persists it via PreferencesPort', () => {
    store.setSidebarCollapsed(true);

    expect(store.sidebarCollapsed()).toBe(true);
    expect(preferences.get(SIDEBAR_COLLAPSED_PREFERENCE_KEY)).toBe('true');
  });

  it('reads the sidebar collapsed flag back across a store rebuild', () => {
    store.setSidebarCollapsed(true);
    TestBed.resetTestingModule();
    configureStore(preferences);
    const rebuiltStore = TestBed.inject(MeetingsStore);

    expect(rebuiltStore.sidebarCollapsed()).toBe(true);
  });
});
