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
  SPLIT_RATIO_PREFERENCE_KEY,
  TRANSCRIPT_COLLAPSED_PREFERENCE_KEY,
} from './meetings.store';

describe('MeetingsStore — split-workspace layout', () => {
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

  it('defaults the split ratio to 0.4 and the transcript to expanded when nothing is stored', () => {
    expect(store.splitRatio()).toBe(0.4);
    expect(store.transcriptCollapsed()).toBe(false);
  });

  it('reflects setSplitRatio and persists it via PreferencesPort', () => {
    store.setSplitRatio(0.55);

    expect(store.splitRatio()).toBe(0.55);
    expect(preferences.get(SPLIT_RATIO_PREFERENCE_KEY)).toBe('0.55');
  });

  it('clamps an out-of-range ratio before storing or applying it', () => {
    store.setSplitRatio(0.95);
    expect(store.splitRatio()).toBe(0.75);

    store.setSplitRatio(0.01);
    expect(store.splitRatio()).toBe(0.25);
  });

  it('reads a stored split ratio back across a store rebuild', () => {
    store.setSplitRatio(0.6);
    TestBed.resetTestingModule();
    configureStore(preferences);
    const rebuiltStore = TestBed.inject(MeetingsStore);

    expect(rebuiltStore.splitRatio()).toBe(0.6);
  });

  it('falls back to the default ratio when the stored preference is not a usable number', () => {
    preferences.set(SPLIT_RATIO_PREFERENCE_KEY, 'not-a-number');
    TestBed.resetTestingModule();
    configureStore(preferences);
    const rebuiltStore = TestBed.inject(MeetingsStore);

    expect(rebuiltStore.splitRatio()).toBe(0.4);
  });

  it('reflects setTranscriptCollapsed and persists it via PreferencesPort', () => {
    store.setTranscriptCollapsed(true);

    expect(store.transcriptCollapsed()).toBe(true);
    expect(preferences.get(TRANSCRIPT_COLLAPSED_PREFERENCE_KEY)).toBe('true');
  });

  it('reads the collapsed flag back across a store rebuild', () => {
    store.setTranscriptCollapsed(true);
    TestBed.resetTestingModule();
    configureStore(preferences);
    const rebuiltStore = TestBed.inject(MeetingsStore);

    expect(rebuiltStore.transcriptCollapsed()).toBe(true);
  });
});
