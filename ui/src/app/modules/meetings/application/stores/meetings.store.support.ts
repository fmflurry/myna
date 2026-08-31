import { defer, retry, timer } from 'rxjs';

import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { createIngestPlaceholder } from '../../core/models/meeting.model';
import type { Summary } from '../../core/models/summary.model';
import type { AudioImportPort } from '../../core/ports/audio-import.port';
import type { MeetingsErrorCode } from '../../core/models/recording-state.model';
import type { MeetingsStore } from './meetings.store';

/** Number of retry attempts for the `import://progress` / `error://occurred` event streams before giving up. */
export const IMPORT_EVENTS_RETRY_COUNT = 5;

/** Delay, in milliseconds, between retry attempts for the import event streams. */
export const IMPORT_EVENTS_RETRY_DELAY_MS = 1000;

/** True for the optimistic placeholder inserted by `ensureIngestMeetingSelected`, never for a real persisted meeting. */
const isIngestPlaceholder = (meeting: Meeting): boolean =>
  meeting.title === 'Importing…' && meeting.durationSec === 0 && !meeting.hasAudio;

/**
 * Removes the optimistic ingest placeholder (see `createIngestPlaceholder`)
 * if it is currently selected — called when a brand-new import is cancelled
 * or fails, so the UI doesn't keep showing a meeting that will never exist.
 * A no-op for a real (already-persisted) selected meeting, and a no-op for
 * re-transcribe, which never creates a placeholder.
 */
export function clearIngestPlaceholderIfSelected(store: MeetingsStore): void {
  const selected = store.selectedMeeting();
  if (selected && isIngestPlaceholder(selected)) {
    store.removeMeeting(selected.id);
  }
}

/**
 * Subscribes `store` to `audioImport`'s `progress()` and `errors()` event
 * streams with a log+bounded-retry discipline: a transient stream failure
 * (e.g. a `listen()` hiccup) is logged via `console.error` and the stream is
 * re-subscribed up to `IMPORT_EVENTS_RETRY_COUNT` times, spaced
 * `IMPORT_EVENTS_RETRY_DELAY_MS` apart, instead of silently dying forever.
 * A no-op when `audioImport` is undefined (some specs predate this port).
 */
export function subscribeToAudioImportEvents(store: MeetingsStore, audioImport: AudioImportPort | undefined): void {
  if (!audioImport) {
    return;
  }

  defer(() => audioImport.progress())
    .pipe(
      retry({
        count: IMPORT_EVENTS_RETRY_COUNT,
        delay: (error) => {
          console.error('[audioImport] progress stream failed', error);
          return timer(IMPORT_EVENTS_RETRY_DELAY_MS);
        },
      }),
    )
    .subscribe((progress) => {
      store.setImportProgress(progress);
      ensureIngestMeetingSelected(store, progress.meetingId);
    });

  defer(() => audioImport.errors())
    .pipe(
      retry({
        count: IMPORT_EVENTS_RETRY_COUNT,
        delay: (error) => {
          console.error('[audioImport] error stream failed', error);
          return timer(IMPORT_EVENTS_RETRY_DELAY_MS);
        },
      }),
    )
    .subscribe((event) => {
      store.setError({ code: event.code as MeetingsErrorCode, message: event.message });
    });
}

/**
 * Lands an edited summary's content in BOTH read paths the detail pane
 * uses: the summary-cache `'loaded'` entry for the (meeting, template,
 * language) triple, AND the selected meeting's matching `summaries` ref
 * (whose markdown the pane prefers). Patching only one would leave the
 * other showing stale content. Never mutates in place; a non-`'loaded'`
 * cache entry and a non-selected meeting are left untouched.
 */
export function applySummaryContentUpdate(
  store: MeetingsStore,
  meetingId: MeetingId,
  template: string,
  language: string,
  summary: Summary,
): void {
  if (store.getSummaryCacheEntry(meetingId, template, language)?.status === 'loaded') {
    store.setSummaryCacheResult(meetingId, template, language, summary);
  }
  const selected = store.selectedMeeting();
  if (selected?.id === meetingId) {
    const summaries = selected.summaries.map((ref) =>
      ref.template === template && ref.language === language
        ? { ...ref, markdown: summary.markdown, createdAt: summary.createdAt }
        : ref,
    );
    store.setSelectedMeeting({ ...selected, summaries });
  }
}

/**
 * Fixes the "brand-new import shows no progress" UX hole: `import_audio`
 * only calls `setSelectedMeeting` once the WHOLE import promise resolves, so
 * for a multi-minute transcription the welcome panel (not the progress
 * header) rendered for the entire run, reading as a hang. The Rust side
 * creates and saves the meeting BEFORE transcription starts and stamps
 * every `import://progress` event with that `meetingId`, so the FIRST
 * progress event is enough to know which meeting is being ingested — this
 * selects it immediately instead of waiting for the promise.
 *
 * A no-op once the right meeting is already selected (covers every progress
 * event after the first, and an ordinary re-transcribe whose target was
 * already selected before it started). When the meeting is merely known but
 * not currently selected (e.g. the user navigated away mid re-transcribe),
 * the REAL record from `MEETINGS` is selected — never a placeholder, which
 * would blow away real data. Only a truly unknown id (a brand-new import)
 * gets an optimistic placeholder, inserted into `MEETINGS` and selected;
 * `runImportAudio` replaces it with the real persisted `Meeting` (same id)
 * once `import_audio` resolves.
 */
export function ensureIngestMeetingSelected(store: MeetingsStore, meetingId: MeetingId): void {
  if (store.selectedMeeting()?.id === meetingId) {
    return;
  }
  const existing = store.meetings().find((meeting) => meeting.id === meetingId);
  if (existing) {
    store.setSelectedMeeting(existing);
    return;
  }
  const placeholder = createIngestPlaceholder(meetingId);
  store.addMeeting(placeholder);
  store.setSelectedMeeting(placeholder);
}
