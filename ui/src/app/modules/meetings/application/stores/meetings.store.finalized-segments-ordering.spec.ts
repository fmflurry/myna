import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, vi } from 'vitest';

import { toMeetingId } from '../../core/models/meeting.model';
import { PreferencesPort } from '../../core/ports/preferences.port';
import { RecorderPort } from '../../core/ports/recorder.port';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import { transcriptSegment } from '../testing/transcript-segment.factory';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { InMemoryTranscriberFake } from '../testing/in-memory-transcriber.fake';
import { MeetingsStore } from './meetings.store';

interface StoreSlots {
  readonly slots: {
    update(key: string, value: unknown): void;
  };
}

/**
 * Split out from `meetings.store.spec.ts` to keep that file under the
 * project's max-lines limit (see `meetings.store.starting-recording.spec.ts`
 * for the same pattern).
 *
 * Covers the live-transcript segment-ordering bug: finalized segments arrive
 * over IPC in decode-completion order, not chronological order (a long
 * system-audio segment starting at 0s can finalize AFTER two short mic
 * segments that started later). The store must insert each arriving segment
 * at its chronological position by `startSec`, not append it.
 */
describe('MeetingsStore finalizedSegments ordering', () => {
  let store: MeetingsStore;
  let transcriber: InMemoryTranscriberFake;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        MeetingsStore,
        { provide: RecorderPort, useClass: InMemoryRecorderFake },
        InMemoryTranscriberFake,
        { provide: TranscriberPort, useExisting: InMemoryTranscriberFake },
        { provide: SummarizerPort, useClass: InMemorySummarizerFake },
        { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
      ],
    });
    store = TestBed.inject(MeetingsStore);
    transcriber = TestBed.inject(InMemoryTranscriberFake);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('inserts finals at their chronological position by startSec, regardless of arrival order', () => {
    // Reproduces the real-recording bug: a long system-audio segment starting
    // at 0s finalizes AFTER two short mic segments that started later.
    transcriber.emitFinal({
      meetingId: toMeetingId('m-1'),
      segment: transcriptSegment({ startSec: 4, endSec: 5, text: 'Yeah.' }),
    });
    transcriber.emitFinal({
      meetingId: toMeetingId('m-1'),
      segment: transcriptSegment({ startSec: 16, endSec: 20, text: "Allo, allo, c'est un test." }),
    });
    transcriber.emitFinal({
      meetingId: toMeetingId('m-1'),
      segment: transcriptSegment({ startSec: 0, endSec: 16, text: 'Others long segment' }),
    });
    vi.advanceTimersByTime(50);

    expect(store.finalizedSegments().map((segment) => segment.startSec)).toEqual([0, 4, 16]);
  });

  it('preserves arrival order when two finals share the same startSec (stable insert)', () => {
    transcriber.emitFinal({
      meetingId: toMeetingId('m-1'),
      segment: transcriptSegment({ startSec: 10, endSec: 11, text: 'first at 10' }),
    });
    transcriber.emitFinal({
      meetingId: toMeetingId('m-1'),
      segment: transcriptSegment({ startSec: 5, endSec: 6, text: 'at 5' }),
    });
    transcriber.emitFinal({
      meetingId: toMeetingId('m-1'),
      segment: transcriptSegment({ startSec: 10, endSec: 11, text: 'second at 10' }),
    });
    vi.advanceTimersByTime(50);

    expect(store.finalizedSegments().map((segment) => segment.text)).toEqual(['at 5', 'first at 10', 'second at 10']);
  });

  it('keeps a long transcript sorted with no drops or duplicates when a late final arrives out of order', () => {
    for (let index = 0; index < 50; index += 1) {
      transcriber.emitFinal({
        meetingId: toMeetingId('m-1'),
        segment: transcriptSegment({ startSec: index * 2 + 1, endSec: index * 2 + 2, text: `Line ${index}` }),
      });
    }
    // Arrives late but belongs near the front chronologically.
    transcriber.emitFinal({
      meetingId: toMeetingId('m-1'),
      segment: transcriptSegment({ startSec: 0, endSec: 1, text: 'Late arriving opener' }),
    });
    vi.advanceTimersByTime(50);

    const segments = store.finalizedSegments();
    expect(segments.length).toBe(51);
    const startSecs = segments.map((segment) => segment.startSec);
    expect(startSecs).toEqual([...startSecs].sort((a, b) => a - b));
    expect(new Set(segments.map((segment) => segment.text)).size).toBe(51);
    expect(segments[0]?.text).toBe('Late arriving opener');
  });

  it('coalesces a timed burst into one bulk state merge after 50 ms, retaining chronological and equal-time arrival order', () => {
    const slots = (store as unknown as StoreSlots).slots;
    const update = vi.spyOn(slots, 'update');
    const finals = [
      transcriptSegment({ startSec: 10, endSec: 11, text: 'first at 10' }),
      transcriptSegment({ startSec: 4, endSec: 5, text: 'at 4' }),
      transcriptSegment({ startSec: 10, endSec: 11, text: 'second at 10' }),
    ];

    for (const segment of finals) {
      transcriber.emitFinal({ meetingId: toMeetingId('m-1'), segment });
    }
    expect(store.finalizedSegments()).toEqual([]);
    vi.advanceTimersByTime(49);
    expect(store.finalizedSegments()).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(store.finalizedSegments().map((segment) => segment.text)).toEqual(['at 4', 'first at 10', 'second at 10']);
    expect(update.mock.calls.filter(([key]) => key === 'FINALIZED_SEGMENTS').length).toBe(1);
  });

  it('flushes at 32 final events and dedupes identical timing-speaker-text identities without dropping distinct arrivals', () => {
    const slots = (store as unknown as StoreSlots).slots;
    const update = vi.spyOn(slots, 'update');
    const duplicate = transcriptSegment({ startSec: 0, endSec: 1, speaker: 'me', text: 'duplicate' });
    const uniqueFinals = Array.from({ length: 31 }, (_, index) =>
      transcriptSegment({ startSec: 31 - index, endSec: 32 - index, speaker: 'others', text: `Line ${31 - index}` }),
    );

    for (const segment of [duplicate, duplicate, ...uniqueFinals]) {
      transcriber.emitFinal({ meetingId: toMeetingId('m-1'), segment });
    }

    const segments = store.finalizedSegments();
    expect(segments.length).toBe(32);
    expect(segments.map((segment) => segment.startSec)).toEqual([...segments].map((segment) => segment.startSec).sort((a, b) => a - b));
    expect(segments.filter((segment) => segment.text === 'duplicate').length).toBe(1);
    expect(update.mock.calls.filter(([key]) => key === 'FINALIZED_SEGMENTS').length).toBe(1);
    vi.advanceTimersByTime(50);
    expect(update.mock.calls.filter(([key]) => key === 'FINALIZED_SEGMENTS').length).toBe(1);
  });
});
