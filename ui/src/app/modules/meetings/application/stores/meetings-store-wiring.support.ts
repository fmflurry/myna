import { syncToStore } from 'flurryx';
import { auditTime, filter, type Observable } from 'rxjs';

import { speakerRole, type TranscriptSegment } from '../../core/models/transcript.model';
import type { RecorderPort } from '../../core/ports/recorder.port';
import type { SummarizerPort } from '../../core/ports/summarizer.port';
import type { TranscriberPort, TranscriptPartial } from '../../core/ports/transcriber.port';
import { DEFAULT_SUMMARY_LANGUAGE_CODE } from '../../core/models/summary-language.model';
import { readStoredExpandedFolders } from './expanded-folders-preferences.util';
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
    .pipe(syncToStore(slots, 'RECORDING_STATE', { completeOnFirstEmission: false }))
    .subscribe();

  recorder
    .effectiveSystemSourceChanges()
    .pipe(syncToStore(slots, 'EFFECTIVE_SYSTEM_SOURCE', { completeOnFirstEmission: false }))
    .subscribe();

  recorder
    .levels()
    .pipe(syncToStore(slots, 'LEVEL', { completeOnFirstEmission: false }))
    .subscribe();

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

  transcriber.finals().subscribe((final) => {
    const current = slots.get('FINALIZED_SEGMENTS')().data ?? [];
    slots.update('FINALIZED_SEGMENTS', {
      data: insertSegmentSorted(current, final.segment),
      status: 'Success',
      isLoading: false,
    });
    slots.update('PARTIAL_TEXT_ME', { data: '', status: 'Success', isLoading: false });
    slots.update('PARTIAL_TEXT_OTHERS', { data: '', status: 'Success', isLoading: false });
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

  slots.update('EXPANDED_FOLDERS', { data: readStoredExpandedFolders(preferences), status: 'Success', isLoading: false });
}
