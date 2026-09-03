import { TestBed } from '@angular/core/testing';

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

/**
 * ADR 0011 Phase 2 (UI re-attach) store surface: the `ACTIVE_RECORDING` slot
 * plus the command-fed write path the boot resume uses. The routed integration
 * spec proves the end-to-end flow; these specs pin the slot semantics the
 * facade depends on — seed/dedupe/clear — without any IPC in the way.
 */
describe('MeetingsStore active recording (ADR 0011 re-attach)', () => {
  let store: MeetingsStore;
  let recorder: InMemoryRecorderFake;
  let transcriber: InMemoryTranscriberFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        MeetingsStore,
        InMemoryRecorderFake,
        { provide: RecorderPort, useExisting: InMemoryRecorderFake },
        InMemoryTranscriberFake,
        { provide: TranscriberPort, useExisting: InMemoryTranscriberFake },
        { provide: SummarizerPort, useClass: InMemorySummarizerFake },
        { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
      ],
    });
    store = TestBed.inject(MeetingsStore);
    recorder = TestBed.inject(InMemoryRecorderFake);
    transcriber = TestBed.inject(InMemoryTranscriberFake);
  });

  describe('ACTIVE_RECORDING slot', () => {
    it('rests null and reflects setActiveRecording', () => {
      expect(store.activeRecording()).toBeNull();

      store.setActiveRecording({ meetingId: toMeetingId('m1'), elapsedSec: 125 });

      expect(store.activeRecording()).toEqual({ meetingId: toMeetingId('m1'), elapsedSec: 125 });
    });

    it('clearActiveRecording retires the slot', () => {
      store.setActiveRecording({ meetingId: toMeetingId('m1'), elapsedSec: 125 });

      store.clearActiveRecording();

      expect(store.activeRecording()).toBeNull();
    });

    it('setRecordingState writes the state machine without touching ACTIVE_RECORDING', () => {
      store.setActiveRecording({ meetingId: toMeetingId('m1'), elapsedSec: 125 });

      store.setRecordingState('recording');

      expect(store.recordingState()).toBe('recording');
      expect(store.activeRecording()?.elapsedSec).toBe(125);
    });

    it('the event-fed idle transition clears ACTIVE_RECORDING (restored baseline never leaks into the next recording)', async () => {
      await recorder.start('Standup');
      store.setActiveRecording({ meetingId: toMeetingId('m1'), elapsedSec: 125 });
      expect(store.activeRecording()).not.toBeNull();

      await recorder.cancel();

      expect(store.recordingState()).toBe('idle');
      expect(store.activeRecording()).toBeNull();
    });

    it('a non-idle event leaves ACTIVE_RECORDING alone', async () => {
      store.setActiveRecording({ meetingId: toMeetingId('m1'), elapsedSec: 125 });

      await recorder.start('Standup');

      expect(store.activeRecording()?.elapsedSec).toBe(125);
    });
  });

  describe('seedFinalizedSegments', () => {
    it('seeds an empty store chronologically, not in journal order', () => {
      store.seedFinalizedSegments([
        transcriptSegment({ startSec: 12, endSec: 15, text: 'later', speaker: 'me' }),
        transcriptSegment({ startSec: 0, endSec: 5, text: 'first', speaker: 'others' }),
        transcriptSegment({ startSec: 6, endSec: 11, text: 'middle', speaker: 'me' }),
      ]);

      expect(store.finalizedSegments().map((segment) => segment.startSec)).toEqual([0, 6, 12]);
    });

    it('dedupes by segment identity against segments the live stream already delivered (event-then-seed)', () => {
      const alreadyDelivered = transcriptSegment({ startSec: 4, endSec: 6, text: 'Yeah.', speaker: 'me' });
      transcriber.emitFinal({ meetingId: toMeetingId('m1'), segment: alreadyDelivered });

      // The journal query races the event stream and returns the same final.
      store.seedFinalizedSegments([
        alreadyDelivered,
        transcriptSegment({ startSec: 8, endSec: 9, text: 'New.', speaker: 'others' }),
      ]);

      expect(store.finalizedSegments().map((segment) => segment.text)).toEqual(['Yeah.', 'New.']);
    });

    it('suppresses a stream final that duplicates an already-seeded segment (seed-then-event)', () => {
      const seeded = transcriptSegment({ startSec: 4, endSec: 6, text: 'Yeah.', speaker: 'me' });
      store.seedFinalizedSegments([seeded]);

      // The journal query resolved first; the same final now arrives over
      // the live `transcript://final` stream — the event path must merge,
      // not append, or the segment double-renders.
      transcriber.emitFinal({ meetingId: toMeetingId('m1'), segment: seeded });

      expect(store.finalizedSegments().map((segment) => segment.text)).toEqual(['Yeah.']);
    });

    it('keeps two same-timing segments whose text differs within one seed batch', () => {
      // Text is part of the identity: a legitimate second segment at the
      // same (startSec, endSec, speaker) — e.g. a re-decode — must never be
      // dropped as a duplicate.
      store.seedFinalizedSegments([
        transcriptSegment({ startSec: 10, endSec: 11, text: 'first at 10', speaker: 'me' }),
        transcriptSegment({ startSec: 10, endSec: 11, text: 'second at 10', speaker: 'me' }),
      ]);

      expect(store.finalizedSegments().map((segment) => segment.text)).toEqual(['first at 10', 'second at 10']);
    });

    it('keeps a stream final with same timing but different text after a seed', () => {
      store.seedFinalizedSegments([transcriptSegment({ startSec: 10, endSec: 11, text: 'seeded', speaker: 'me' })]);

      transcriber.emitFinal({
        meetingId: toMeetingId('m1'),
        segment: transcriptSegment({ startSec: 10, endSec: 11, text: 'live', speaker: 'me' }),
      });

      expect(store.finalizedSegments().map((segment) => segment.text)).toEqual(['seeded', 'live']);
    });

    it('treats a different speaker as a distinct segment (dual-track overlap at the same timestamps)', () => {
      store.seedFinalizedSegments([
        transcriptSegment({ startSec: 0, endSec: 5, text: 'Me line', speaker: 'me' }),
        transcriptSegment({ startSec: 0, endSec: 5, text: 'Others line', speaker: 'others' }),
      ]);

      expect(store.finalizedSegments().map((segment) => segment.speaker)).toEqual(['me', 'others']);
    });

    it('dedupes within the incoming batch itself', () => {
      const dupe = transcriptSegment({ startSec: 2, endSec: 3, text: 'Hello.', speaker: 'me' });

      store.seedFinalizedSegments([dupe, { ...dupe }, dupe]);

      expect(store.finalizedSegments().length).toBe(1);
    });

    it('never mutates the previously published array', () => {
      store.seedFinalizedSegments([transcriptSegment({ startSec: 0, endSec: 1, text: 'a', speaker: 'me' })]);
      const before = store.finalizedSegments();

      store.seedFinalizedSegments([transcriptSegment({ startSec: 2, endSec: 3, text: 'b', speaker: 'me' })]);

      expect(before.length).toBe(1);
      expect(store.finalizedSegments()).not.toBe(before);
    });

    it('seeding an empty journal is a no-op (session stopped mid-resume)', () => {
      store.seedFinalizedSegments([]);

      expect(store.finalizedSegments()).toEqual([]);
    });
  });
});
