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
}

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
