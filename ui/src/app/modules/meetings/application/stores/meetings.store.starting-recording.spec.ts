import { TestBed } from '@angular/core/testing';

import { PreferencesPort } from '../../core/ports/preferences.port';
import { RecorderPort } from '../../core/ports/recorder.port';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { InMemoryTranscriberFake } from '../testing/in-memory-transcriber.fake';
import { MeetingsStore } from './meetings.store';

/**
 * Split out from `meetings.store.spec.ts` to keep that file under the
 * project's max-lines limit (see `meetings-shell.page.selection.spec.ts` for
 * the same pattern applied to a page spec).
 */
describe('MeetingsStore startingRecording', () => {
  let store: MeetingsStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        MeetingsStore,
        { provide: RecorderPort, useClass: InMemoryRecorderFake },
        { provide: TranscriberPort, useClass: InMemoryTranscriberFake },
        { provide: SummarizerPort, useClass: InMemorySummarizerFake },
        { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
      ],
    });
    store = TestBed.inject(MeetingsStore);
  });

  it('starts false and reflects setStartingRecording', () => {
    expect(store.startingRecording()).toBe(false);

    store.setStartingRecording(true);
    expect(store.startingRecording()).toBe(true);

    store.setStartingRecording(false);
    expect(store.startingRecording()).toBe(false);
  });
});
