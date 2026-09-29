import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { toMeetingId } from '../../core/models/meeting.model';
import { AudioImportPort } from '../../core/ports/audio-import.port';
import { PreferencesPort } from '../../core/ports/preferences.port';
import { RecorderPort } from '../../core/ports/recorder.port';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import { transcriptSegment } from '../testing/transcript-segment.factory';
import { InMemoryAudioImportFake } from '../testing/in-memory-audio-import.fake';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { InMemoryTranscriberFake } from '../testing/in-memory-transcriber.fake';
import { MeetingsStore, PARTIAL_UI_AUDIT_MS, type MeetingsSlots } from './meetings.store';
import { FINAL_BATCH_MS } from './meetings-store-wiring.support';

/** Generous bound: bounded live-hot-path state must never carry ~one history entry per update. */
const MAX_ACCEPTABLE_HISTORY_GROWTH = 50;

const LEVEL_UPDATE_COUNT = 5000;
const LIVE_SEGMENT_COUNT = 300;

/**
 * White-box perf regression guard. Reaches into the store's private flurryx
 * `slots` instance purely to read `getHistory().length` — flurryx records one
 * deep-cloned FULL STORE snapshot per acknowledged update, unbounded, with no
 * `StoreOptions` knob to cap or disable it (confirmed against
 * `node_modules/@flurryx/store/dist/index.d.ts`: `StoreOptions` only extends
 * `StoreMessageChannelOptions`). No production file is touched to expose
 * this; the cast is typed against the already-exported `MeetingsSlots` type
 * (never `any`), since `IStore.getHistory(): readonly StoreHistoryEntry[]`
 * is part of that type's public surface.
 */
function historyLengthOf(store: MeetingsStore): number {
  return (store as unknown as { readonly slots: MeetingsSlots }).slots.getHistory().length;
}

describe('MeetingsStore live hot path (perf regression guard)', () => {
  let store: MeetingsStore;
  let recorder: InMemoryRecorderFake;
  let transcriber: InMemoryTranscriberFake;

  beforeEach(() => {
    // Fake timers BEFORE construction: the finals batch window schedules its
    // recurring flush timer at subscribe time (see meetings.store.spec.ts).
    vi.useFakeTimers();
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
        { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
      ],
    });
    store = TestBed.inject(MeetingsStore);
    recorder = TestBed.inject(InMemoryRecorderFake);
    transcriber = TestBed.inject(InMemoryTranscriberFake);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps store history bounded across a sustained high-frequency LEVEL stream (10 Hz), not one entry per update', () => {
    const before = historyLengthOf(store);

    for (let i = 0; i < LEVEL_UPDATE_COUNT; i += 1) {
      recorder.emitLevel({ rms: i % 100, dbfs: -(i % 60) });
    }

    const after = historyLengthOf(store);
    // Today `levels()` is forwarded to the LEVEL slot with no throttle
    // (`syncToStore` in meetings-store-wiring.support.ts), so every
    // emitLevel() call lands as its own flurryx-acknowledged update and
    // `after - before` grows 1:1 with LEVEL_UPDATE_COUNT — this fails (RED)
    // until LEVEL moves off flurryx onto a plain signal that never
    // contributes a history entry.
    expect(after - before).toBeLessThan(MAX_ACCEPTABLE_HISTORY_GROWTH);
  });

  it('keeps store history bounded across a sustained burst of live partials and finalized segments', () => {
    const before = historyLengthOf(store);

    for (let i = 0; i < LIVE_SEGMENT_COUNT; i += 1) {
      transcriber.emitPartial({ meetingId: toMeetingId('m-1'), text: `partial ${i}`, speaker: 'me' });
      vi.advanceTimersByTime(PARTIAL_UI_AUDIT_MS);
      transcriber.emitFinal({
        meetingId: toMeetingId('m-1'),
        segment: transcriptSegment({ startSec: i, endSec: i + 1, text: `Sentence ${i}` }),
      });
      vi.advanceTimersByTime(FINAL_BATCH_MS);
    }

    expect(store.finalizedSegments().length).toBe(LIVE_SEGMENT_COUNT);

    const after = historyLengthOf(store);
    // Today each audited partial flush AND each batched finals flush is its
    // own flurryx-acknowledged update to PARTIAL_TEXT_ME/FINALIZED_SEGMENTS —
    // roughly two history entries per iteration, growing unbounded with
    // stream duration. This fails (RED) until PARTIAL_TEXT_ME/OTHERS and
    // FINALIZED_SEGMENTS move off flurryx onto plain signals.
    expect(after - before).toBeLessThan(MAX_ACCEPTABLE_HISTORY_GROWTH);
  });
});
