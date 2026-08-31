import type { FolderId } from './folder.model';
import type { Summary } from './summary.model';
import type { Transcript } from './transcript.model';

export type MeetingId = string & { readonly __brand: 'MeetingId' };

export const toMeetingId = (id: string): MeetingId => id as MeetingId;

export interface Meeting {
  readonly id: MeetingId;
  readonly title: string;
  readonly createdAt: Date;
  readonly durationSec: number;
  readonly audioPath?: string;
  readonly transcript?: Transcript;
  readonly summaries: readonly Summary[];
  readonly archived: boolean;
  /** Derived server-side flag: whether `audio.wav` exists on disk for this meeting. */
  readonly hasAudio: boolean;
  /** Derived server-side flag: whether `track-system.wav` exists on disk for this meeting — gates "Detect speakers". */
  readonly hasSystemTrack: boolean;
  /** Count of audio chunks silently dropped during recording. Non-zero means the transcript is incomplete while the audio file is intact; reset to 0 by a successful re-transcribe. */
  readonly droppedAudioChunks: number;
  /** The folder this meeting is filed under. Absent (never `undefined`) means unfiled — see `withFolder`. */
  readonly folderId?: FolderId;
  /** Display names keyed by flat speaker label (e.g. `'others:1'` -> `'Jean'`).
      Absent on meetings persisted before speaker naming. */
  readonly speakerNames?: Readonly<Record<string, string>>;
}

/**
 * Optimistic placeholder inserted the moment the FIRST `import://progress` /
 * `retranscribe` progress event names a meeting the store doesn't know about
 * yet (a brand-new "Import audio", not a re-transcribe of an already-loaded
 * meeting) — see `MeetingsStore`. Replaced by the real persisted `Meeting`
 * once `import_audio` resolves and calls `addMeeting`/`setSelectedMeeting`
 * with the same id.
 */
export const createIngestPlaceholder = (id: MeetingId): Meeting => ({
  id,
  title: 'Importing…',
  createdAt: new Date(),
  durationSec: 0,
  summaries: [],
  archived: false,
  hasAudio: false,
  hasSystemTrack: false,
  droppedAudioChunks: 0,
});

export const withTranscript = (meeting: Meeting, transcript: Transcript): Meeting => ({
  ...meeting,
  transcript,
});

export const withSummary = (meeting: Meeting, summary: Summary): Meeting => ({
  ...meeting,
  summaries: [...meeting.summaries, summary],
});

export const withDuration = (meeting: Meeting, durationSec: number): Meeting => ({
  ...meeting,
  durationSec,
});

export const withArchived = (meeting: Meeting, archived: boolean): Meeting => ({
  ...meeting,
  archived,
});

/**
 * Sets or clears (via `undefined`) `folderId`. `exactOptionalPropertyTypes`
 * forbids assigning `undefined` to an optional key, so clearing removes the
 * key entirely rather than setting it to `undefined`.
 */
export const withFolder = (meeting: Meeting, folderId: FolderId | undefined): Meeting => {
  const { folderId: previousFolderId, ...withoutFolderId } = meeting;
  void previousFolderId;
  return folderId !== undefined ? { ...withoutFolderId, folderId } : withoutFolderId;
};
