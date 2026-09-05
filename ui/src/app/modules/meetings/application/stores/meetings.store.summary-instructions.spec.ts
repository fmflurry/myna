import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import { PreferencesPort } from '../../core/ports/preferences.port';
import { RecorderPort } from '../../core/ports/recorder.port';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { InMemoryTranscriberFake } from '../testing/in-memory-transcriber.fake';
import { summaryInstructionsKey } from './summary-instructions-preferences.util';
import { MeetingsStore } from './meetings.store';

/**
 * Covers the summary-instructions additions: the per-(meeting, template)
 * draft slot persisting through `PreferencesPort` and surviving a store
 * rebuild, and the guidelines slot being settable ONLY via the setter (the
 * server owns its durability — nothing lands in preferences).
 */
describe('MeetingsStore summary instructions', () => {
  // Shared across BOTH store instances built in the rebuild test — the whole
  // point is that persistence lives in the preferences backend, not the store.
  const preferences = new InMemoryPreferencesFake();

  const buildStore = (): MeetingsStore => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        MeetingsStore,
        InMemoryRecorderFake,
        { provide: RecorderPort, useExisting: InMemoryRecorderFake },
        InMemoryTranscriberFake,
        { provide: TranscriberPort, useExisting: InMemoryTranscriberFake },
        { provide: SummarizerPort, useClass: InMemorySummarizerFake },
        { provide: PreferencesPort, useValue: preferences },
      ],
    });
    return TestBed.inject(MeetingsStore);
  };

  it('defaults the draft before anything is set', () => {
    const store = buildStore();

    expect(store.summaryInstructionDraft(toMeetingId('si-1'), 'key-points')).toEqual({ text: '', includeGeneral: true });
  });

  it('setSummaryInstructionDraft writes through PreferencesPort and updates the slot', () => {
    const store = buildStore();
    const draft = { text: 'Focus on blockers', includeGeneral: false };

    store.setSummaryInstructionDraft(toMeetingId('si-2'), 'key-points', draft);

    expect(store.summaryInstructionDraft(toMeetingId('si-2'), 'key-points')).toEqual(draft);
    expect(preferences.get(summaryInstructionsKey(toMeetingId('si-2'), 'key-points'))).toBe(JSON.stringify(draft));
  });

  it('draft survives a store rebuild sharing the same PreferencesPort', () => {
    const store = buildStore();
    const draft = { text: 'Decisions only', includeGeneral: true };
    store.setSummaryInstructionDraft(toMeetingId('si-3'), 'action-items', draft);

    const rebuilt = buildStore();

    expect(rebuilt.summaryInstructionDraft(toMeetingId('si-3'), 'action-items')).toEqual(draft);
  });

  it('guidelines slot starts empty and updates via the setter', () => {
    const store = buildStore();
    expect(store.summaryGuidelines()).toBe('');

    store.setSummaryGuidelines('Always list action owners.');

    expect(store.summaryGuidelines()).toBe('Always list action owners.');
  });

  it('guidelines are never persisted: a rebuilt store starts empty again', () => {
    const store = buildStore();
    store.setSummaryGuidelines('from server');
    expect(store.summaryGuidelines()).toBe('from server');

    const rebuilt = buildStore();

    expect(rebuilt.summaryGuidelines()).toBe('');
  });
});
