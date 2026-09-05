import { syncToStore } from 'flurryx';
import { auditTime, bufferTime, distinct, filter, tap, type Observable } from 'rxjs';

import { speakerRole, type TranscriptSegment } from '../../core/models/transcript.model';
import type { RecorderPort } from '../../core/ports/recorder.port';
import type { SummarizerPort } from '../../core/ports/summarizer.port';
import type { TranscriberPort, TranscriptPartial } from '../../core/ports/transcriber.port';
import { DEFAULT_SUMMARY_LANGUAGE_CODE } from '../../core/models/summary-language.model';
import { readStoredExpandedFolders } from './expanded-folders-preferences.util';
import { readStoredSidebarCollapsed, readStoredSidebarWidth } from './sidebar-layout-preferences.util';
import { readStoredSplitRatio, readStoredTranscriptCollapsed } from './split-layout-preferences.util';
import {
  AUDIO_SOURCE_PREFERENCE_KEY,
  CAPTURE_SOURCE_PREFERENCE_KEY,
  DEFAULT_CAPTURE_SOURCE,
  DEFAULT_AUDIO_SOURCE_ID,
  MIC_DEVICE_PREFERENCE_KEY,
  SUMMARY_LANGUAGE_PREFERENCE_KEY,
  isCaptureSource,
} from './meetings-store-preferences.util';
import type { PreferencesPort } from '../../core/ports/preferences.port';
import type { MeetingsSlots } from './meetings.store';

/**
 * Splits the raw partials stream into the two BOUNDED live-caption slots
 * BEFORE auditing, so each slot gets its OWN independent audit window.
 * Auditing the shared stream first would let a same-window "me" partial get
 * silently dropped by a later "others" partial (or vice-versa) — the two
 * speakers must never starve each other. Only `'me'` routes to the "me"
 * partition; every other role — `'others'`, any sub-identity (which
 * collapses into the shared "others" slot until diarization ships), and
 * `'unknown'` — routes to "others", so a partial is never silently dropped.
 */
const partialsFor = (
  partials: Observable<TranscriptPartial>,
  role: 'me' | 'others',
): Observable<TranscriptPartial> =>
  partials.pipe(filter((partial) => (speakerRole(partial.speaker) === 'me') === (role === 'me')));

/**
 * Minimum spacing, in milliseconds, between live partial-transcript
 * updates reaching the UI. `TranscriberPort.partials()` can fire far more
 * often than the UI needs to redraw (each partial re-decode this store
 * receives can trigger a synchronous reflow downstream — see
 * `live-transcript.component.ts`'s scroll effect); auditing here bounds
 * that redraw rate regardless of how bursty the underlying event stream
 * is. Finals are never throttled — only partials, which are inherently
 * provisional.
 */
export const PARTIAL_UI_AUDIT_MS = 100;

/** Maximum time finalized events wait before one chronological store merge. */
export const FINAL_BATCH_MS = 50;

/** Maximum finalized events merged in one store update. */
export const FINAL_BATCH_SIZE = 32;

/**
 * Binary-search insertion index for `startSec` within `segments`, which is
 * assumed already sorted ascending by `startSec`. Ties resolve to the index
 * AFTER every existing segment sharing that `startSec`, so inserting there
 * preserves arrival order among equal timestamps (stable insert).
 */
function sortedInsertIndex(segments: readonly TranscriptSegment[], startSec: number): number {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (segments[mid]!.startSec <= startSec) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * Returns a NEW array with `segment` inserted at its chronological position
 * by `startSec` — never mutates `segments`. Finalized segments arrive over
 * IPC in decode-completion order, not chronological order (a long system-
 * audio segment starting at 0s can finalize after two short mic segments
 * that start later), so a plain append would leak arrival order into the
 * rendered transcript. Binary search keeps this O(log n + n) per arrival
 * instead of re-sorting the whole (potentially thousands-of-segments)
 * transcript on every event.
 */
export function insertSegmentSorted(
  segments: readonly TranscriptSegment[],
  segment: TranscriptSegment,
): readonly TranscriptSegment[] {
  const index = sortedInsertIndex(segments, segment.startSec);
  return [...segments.slice(0, index), segment, ...segments.slice(index)];
}

/**
 * Identity a journaled final shares with the same segment delivered over
 * `transcript://final`. `text` is part of the key deliberately: two segments
 * with identical `(startSec, endSec, speaker)` but different text are two
 * legitimate arrivals (e.g. a re-decode of the same span), and a key without
 * text would silently drop the second one.
 */
const segmentIdentityKey = (segment: TranscriptSegment): string =>
  `${segment.startSec}|${segment.endSec}|${segment.speaker}|${segment.text}`;

/**
 * Returns a NEW chronologically-sorted array with every segment from `incoming`
 * that `existing` doesn't already hold inserted at its sorted position — never
 * mutates `existing`. This is the SINGLE merge both the journal seed (ADR 0011
 * reload replay) and the live `transcript://final` event path go through: the
 * journal and the stream overlap (a final can land on either side of the seed,
 * in either order), so routing both through here suppresses duplicates in BOTH
 * orderings. Segments are deduped by `segmentIdentityKey` — timing, speaker,
 * AND text — so a same-timing different-text segment is kept, not dropped.
 */
export function mergeFinalizedSegments(
  existing: readonly TranscriptSegment[],
  incoming: readonly TranscriptSegment[],
): readonly TranscriptSegment[] {
  const seen = new Set(existing.map(segmentIdentityKey));
  let merged = existing;
  for (const segment of incoming) {
    const key = segmentIdentityKey(segment);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged = insertSegmentSorted(merged, segment);
  }
  return merged;
}

/**
 * Bridges `RecorderPort` / `TranscriberPort` / `SummarizerPort` observables
 * directly into `slots`. Extracted out of `MeetingsStore`'s constructor so
 * that class stays under the project's `max-lines` budget; this function is
 * only ever called once, from there.
 */
export function wireRecorderAndTranscriberEvents(
  slots: MeetingsSlots,
  recorder: RecorderPort,
  transcriber: TranscriberPort,
  summarizer: SummarizerPort,
): void {
  recorder
    .stateChanges()
    .pipe(
      // A session that ends (naturally, via Stop, or via Cancel) retires its
      // restored-snapshot slot, so the boot-only `ACTIVE_RECORDING` elapsed
      // baseline can never leak into the NEXT recording's timer. The event
      // stream carries no elapsed clock (`elapsedSec` is null on events by
      // contract), so only the idle transition is acted on here. A finished
      // stop also retires its phase label for the same leak reason.
      tap((state) => {
        if (state === 'idle') {
          slots.update('ACTIVE_RECORDING', { data: null, status: 'Success', isLoading: false });
          slots.update('STOP_PHASE', { data: null, status: 'Success', isLoading: false });
        }
      }),
      syncToStore(slots, 'RECORDING_STATE', { completeOnFirstEmission: false }),
    )
    .subscribe();

  recorder
    .effectiveSystemSourceChanges()
    .pipe(syncToStore(slots, 'EFFECTIVE_SYSTEM_SOURCE', { completeOnFirstEmission: false }))
    .subscribe();

  recorder
    .levels()
    .pipe(syncToStore(slots, 'LEVEL', { completeOnFirstEmission: false }))
    .subscribe();

  recorder
    .stopProgressChanges()
    .pipe(syncToStore(slots, 'STOP_PHASE', { completeOnFirstEmission: false }))
    .subscribe();

  recorder
    .healthChanges()
    .pipe(syncToStore(slots, 'RECORDING_HEALTH', { completeOnFirstEmission: false }))
    .subscribe();

  // `recording://completed` is the ONLY event allowed to end 'stopping': the
  // stop command itself resolves with an acknowledgement, never a meeting.
  // Landing the durable row means upserting it (the in-flight row from
  // start shares its id, so this is exactly-once, never a duplicate),
  // selecting it, retiring the stop-phase slots, and taking the state
  // machine to idle. Mirrors `MeetingsStore.setSelectedMeeting`'s history
  // clear: the finalized meeting replaces the selection, so any captured
  // speaker-op inverse now targets a stale row.
  recorder.completedMeetings().subscribe((meeting) => {
    const rest = (slots.get('MEETINGS')().data ?? []).filter(
      (existing) => existing.id !== meeting.id,
    );
    slots.update('MEETINGS', { data: [meeting, ...rest], status: 'Success', isLoading: false });
    slots.update('SELECTED_MEETING', { data: meeting, status: 'Success', isLoading: false });
    slots.update('SPEAKER_HISTORY', { data: [], status: 'Success', isLoading: false });
    slots.update('TRANSCRIPT_UNDO', { data: null, status: 'Success', isLoading: false });
    slots.update('STOP_PHASE', { data: null, status: 'Success', isLoading: false });
    slots.update('ACTIVE_RECORDING', { data: null, status: 'Success', isLoading: false });
    slots.update('RECORDING_STATE', { data: 'idle', status: 'Success', isLoading: false });
  });

  const partials = transcriber.partials();

  partialsFor(partials, 'me')
    .pipe(auditTime(PARTIAL_UI_AUDIT_MS))
    .subscribe((partial) => {
      slots.update('PARTIAL_TEXT_ME', { data: partial.text, status: 'Success', isLoading: false });
    });

  partialsFor(partials, 'others')
    .pipe(auditTime(PARTIAL_UI_AUDIT_MS))
    .subscribe((partial) => {
      slots.update('PARTIAL_TEXT_OTHERS', { data: partial.text, status: 'Success', isLoading: false });
    });

  transcriber
    .finals()
    .pipe(
      tap(() => {
        // A final immediately supersedes either streaming partial, even while
        // its durable transcript insertion waits for the short batch window.
        slots.update('PARTIAL_TEXT_ME', { data: '', status: 'Success', isLoading: false });
        slots.update('PARTIAL_TEXT_OTHERS', { data: '', status: 'Success', isLoading: false });
      }),
      // Dedupe before applying the size limit so 32 distinct final segments
      // flush immediately even when the transport repeats one in the burst.
      distinct((final) => segmentIdentityKey(final.segment)),
      bufferTime(FINAL_BATCH_MS, undefined, FINAL_BATCH_SIZE),
      filter((finals) => finals.length > 0),
    )
    .subscribe((finals) => {
      const current = slots.get('FINALIZED_SEGMENTS')().data ?? [];
      // One stable merge dedupes the batch and preserves equal-start arrival
      // order while making a single finalized-segment slot update.
      slots.update('FINALIZED_SEGMENTS', {
        data: mergeFinalizedSegments(
          current,
          finals.map((final) => final.segment),
        ),
        status: 'Success',
        isLoading: false,
      });
    });

  summarizer.tokens().subscribe((token) => {
    // No `language` on the wire; `Busy`-guarded concurrency means template alone disambiguates.
    const activeKey = slots.get('SUMMARIZING_KEY')().data;
    if (activeKey?.template !== token.template) {
      return;
    }
    const current = slots.get('SUMMARY_STREAM')().data ?? '';
    slots.update('SUMMARY_STREAM', {
      data: current + token.token,
      status: 'Success',
      isLoading: false,
    });
  });

  summarizer.done().subscribe((summary) => {
    slots.update('SUMMARY_STREAM', { data: summary.markdown, status: 'Success', isLoading: false });
  });
}

/**
 * Seeds the preference-backed slots (summary language, capture source,
 * audio source, mic device, split layout, expanded folders) from
 * `PreferencesPort` ONCE at store construction, so every seeded value
 * survives a store rebuild (app relaunch, or a fresh injector in tests
 * sharing the same preferences backend) — never re-read on later access.
 * The mic selection is seeded from the persisted device NAME; `null` (the
 * default-sentinel) when nothing is stored — `loadDevices` later validates
 * a persisted name against the fresh device list.
 */
export function seedPersistedPreferences(slots: MeetingsSlots, preferences: PreferencesPort): void {
  const storedLanguage = preferences.get(SUMMARY_LANGUAGE_PREFERENCE_KEY);
  slots.update('SELECTED_SUMMARY_LANGUAGE', { data: storedLanguage ?? DEFAULT_SUMMARY_LANGUAGE_CODE, status: 'Success', isLoading: false });

  const storedCaptureSource = preferences.get(CAPTURE_SOURCE_PREFERENCE_KEY);
  slots.update('CAPTURE_SOURCE', {
    data: isCaptureSource(storedCaptureSource) ? storedCaptureSource : DEFAULT_CAPTURE_SOURCE,
    status: 'Success',
    isLoading: false,
  });
  const storedAudioSource = preferences.get(AUDIO_SOURCE_PREFERENCE_KEY);
  slots.update('SELECTED_AUDIO_SOURCE', { data: storedAudioSource ?? DEFAULT_AUDIO_SOURCE_ID, status: 'Success', isLoading: false });

  const storedMicDevice = preferences.get(MIC_DEVICE_PREFERENCE_KEY);
  if (storedMicDevice) {
    slots.update('SELECTED_DEVICE', { data: { name: storedMicDevice }, status: 'Success', isLoading: false });
  }

  slots.update('SPLIT_RATIO', { data: readStoredSplitRatio(preferences), status: 'Success', isLoading: false });
  slots.update('TRANSCRIPT_COLLAPSED', { data: readStoredTranscriptCollapsed(preferences), status: 'Success', isLoading: false });

  slots.update('SIDEBAR_WIDTH', { data: readStoredSidebarWidth(preferences), status: 'Success', isLoading: false });
  slots.update('SIDEBAR_COLLAPSED', { data: readStoredSidebarCollapsed(preferences), status: 'Success', isLoading: false });

  slots.update('EXPANDED_FOLDERS', { data: readStoredExpandedFolders(preferences), status: 'Success', isLoading: false });
}
