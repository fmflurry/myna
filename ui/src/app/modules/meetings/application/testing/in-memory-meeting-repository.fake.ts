import { Injectable } from '@angular/core';

import type { FolderId } from '../../core/models/folder.model';
import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { withArchived, withFolder, withTranscript } from '../../core/models/meeting.model';
import { MeetingsError } from '../../core/models/recording-state.model';
import type { TranscriptSegment } from '../../core/models/transcript.model';
import { withSegmentText } from '../../core/models/transcript.model';
import {
  MeetingRepositoryPort,
  type MeetingExportFormat,
} from '../../core/ports/meeting-repository.port';

/** In-memory MeetingRepositoryPort implementation for specs and the placeholder providers. */
@Injectable()
export class InMemoryMeetingRepositoryFake extends MeetingRepositoryPort {
  private meetings: readonly Meeting[] = [];

  override async list(): Promise<readonly Meeting[]> {
    return this.meetings;
  }

  override async get(id: MeetingId): Promise<Meeting> {
    const found = this.meetings.find((meeting) => meeting.id === id);
    if (!found) {
      throw new MeetingsError('NOT_FOUND', `Meeting ${id} was not found.`);
    }
    return found;
  }

  override async delete(id: MeetingId): Promise<void> {
    this.meetings = this.meetings.filter((meeting) => meeting.id !== id);
  }

  override async rename(id: MeetingId, title: string): Promise<Meeting> {
    const found = this.meetings.find((meeting) => meeting.id === id);
    if (!found) {
      throw new MeetingsError('NOT_FOUND', `Meeting ${id} was not found.`);
    }
    const renamed: Meeting = { ...found, title };
    this.meetings = this.meetings.map((meeting) => (meeting.id === id ? renamed : meeting));
    return renamed;
  }

  override async setArchived(id: MeetingId, archived: boolean): Promise<Meeting> {
    const found = this.meetings.find((meeting) => meeting.id === id);
    if (!found) {
      throw new MeetingsError('NOT_FOUND', `Meeting ${id} was not found.`);
    }
    const updated: Meeting = { ...found, archived };
    this.meetings = this.meetings.map((meeting) => (meeting.id === id ? updated : meeting));
    return updated;
  }

  override async setFolder(id: MeetingId, folderId: FolderId | null): Promise<Meeting> {
    const found = this.meetings.find((meeting) => meeting.id === id);
    if (!found) {
      throw new MeetingsError('NOT_FOUND', `Meeting ${id} was not found.`);
    }
    const updated = withFolder(found, folderId ?? undefined);
    this.meetings = this.meetings.map((meeting) => (meeting.id === id ? updated : meeting));
    return updated;
  }

  /**
   * Test double for `MeetingRepositoryPort.place` — sets folder + archived in
   * one call, mirroring `set_meeting_placement`. `previousId`/`nextId` are
   * accepted but intentionally NOT modeled: the Angular `Meeting` never gains
   * a `position` field (rendered order stays the sole UI sort authority), so
   * there is nothing here for them to mutate.
   */
  override async place(
    id: MeetingId,
    folderId: FolderId | null,
    archived: boolean,
    previousId: MeetingId | null,
    nextId: MeetingId | null,
  ): Promise<Meeting> {
    void previousId;
    void nextId;
    const found = this.meetings.find((meeting) => meeting.id === id);
    if (!found) {
      throw new MeetingsError('NOT_FOUND', `Meeting ${id} was not found.`);
    }
    const updated = withArchived(withFolder(found, folderId ?? undefined), archived);
    this.meetings = this.meetings.map((meeting) => (meeting.id === id ? updated : meeting));
    return updated;
  }

  override async editTranscriptSegment(id: MeetingId, index: number, text: string): Promise<Meeting> {
    const found = this.meetings.find((meeting) => meeting.id === id);
    if (!found?.transcript || index < 0 || index >= found.transcript.segments.length) {
      throw new MeetingsError('NOT_FOUND', `Meeting ${id} has no transcript segment at index ${index}.`);
    }
    const updated = withTranscript(found, withSegmentText(found.transcript, index, text.trim()));
    this.meetings = this.meetings.map((meeting) => (meeting.id === id ? updated : meeting));
    return updated;
  }

  override async renameSpeaker(id: MeetingId, label: string, name: string): Promise<Meeting> {
    const found = this.meetings.find((meeting) => meeting.id === id);
    if (!found) {
      throw new MeetingsError('NOT_FOUND', `Meeting ${id} was not found.`);
    }
    const { [label]: _existing, ...withoutLabel } = found.speakerNames ?? {};
    void _existing;
    const speakerNames = name === '' ? withoutLabel : { ...withoutLabel, [label]: name };
    const updated = this.withSpeakerNames(
      found,
      Object.keys(speakerNames).length > 0 ? speakerNames : undefined,
    );
    this.meetings = this.meetings.map((meeting) => (meeting.id === id ? updated : meeting));
    return updated;
  }

  /**
   * Collapses every segment attributed to `label` to bare `'others'` and
   * drops the display-name entry, mirroring the Rust `remove_speaker`
   * command. Succeeds as a no-op when the meeting has no transcript — only
   * the name map is guaranteed to change; there is nothing to collapse.
   * Idempotent: a second call finds nothing left to collapse and still
   * returns cleanly.
   */
  override async removeSpeaker(id: MeetingId, label: string): Promise<Meeting> {
    const found = this.meetings.find((meeting) => meeting.id === id);
    if (!found) {
      throw new MeetingsError('NOT_FOUND', `Meeting ${id} was not found.`);
    }
    const { [label]: _removed, ...remainingNames } = found.speakerNames ?? {};
    void _removed;
    const withNames = this.withSpeakerNames(
      found,
      Object.keys(remainingNames).length > 0 ? remainingNames : undefined,
    );
    const updated = withNames.transcript
      ? withTranscript(withNames, {
          segments: withNames.transcript.segments.map((segment) =>
            segment.speaker === label ? { ...segment, speaker: 'others' } : segment,
          ),
        })
      : withNames;
    this.meetings = this.meetings.map((meeting) => (meeting.id === id ? updated : meeting));
    return updated;
  }

  override async setSegmentSpeaker(id: MeetingId, index: number, speaker: string): Promise<Meeting> {
    const found = this.meetings.find((meeting) => meeting.id === id);
    if (!found?.transcript || index < 0 || index >= found.transcript.segments.length) {
      throw new MeetingsError('NOT_FOUND', `Meeting ${id} has no transcript segment at index ${index}.`);
    }
    const updated = withTranscript(found, {
      segments: found.transcript.segments.map((segment, i) =>
        i === index ? { ...segment, speaker } : segment,
      ),
    });
    this.meetings = this.meetings.map((meeting) => (meeting.id === id ? updated : meeting));
    return updated;
  }

  override async deleteTranscriptSegment(
    id: MeetingId,
    index: number,
    expectedText: string,
  ): Promise<Meeting> {
    void expectedText;
    const found = this.meetings.find((meeting) => meeting.id === id);
    if (!found?.transcript || index < 0 || index >= found.transcript.segments.length) {
      throw new MeetingsError('NOT_FOUND', `Meeting ${id} has no transcript segment at index ${index}.`);
    }
    const updated = withTranscript(found, {
      segments: found.transcript.segments.filter((_segment, i) => i !== index),
    });
    this.meetings = this.meetings.map((meeting) => (meeting.id === id ? updated : meeting));
    return updated;
  }

  override async mergeTranscriptSegmentUp(
    id: MeetingId,
    index: number,
    expectedText: string,
  ): Promise<Meeting> {
    void expectedText;
    const found = this.meetings.find((meeting) => meeting.id === id);
    if (!found?.transcript || index <= 0 || index >= found.transcript.segments.length) {
      throw new MeetingsError('NOT_FOUND', `Meeting ${id} has no transcript segment at index ${index}.`);
    }
    const segments = found.transcript.segments;
    const previous = segments[index - 1]!;
    const current = segments[index]!;
    const merged: TranscriptSegment = {
      ...previous,
      endSec: current.endSec,
      text: `${previous.text} ${current.text}`,
    };
    const updated = withTranscript(found, {
      segments: [...segments.slice(0, index - 1), merged, ...segments.slice(index + 1)],
    });
    this.meetings = this.meetings.map((meeting) => (meeting.id === id ? updated : meeting));
    return updated;
  }

  override async restoreTranscriptSegments(
    id: MeetingId,
    index: number,
    removeCount: number,
    segments: readonly TranscriptSegment[],
  ): Promise<Meeting> {
    const found = this.meetings.find((meeting) => meeting.id === id);
    if (!found?.transcript || index < 0 || index > found.transcript.segments.length) {
      throw new MeetingsError('NOT_FOUND', `Meeting ${id} has no transcript segment at index ${index}.`);
    }
    const updatedSegments = [...found.transcript.segments];
    updatedSegments.splice(index, removeCount, ...segments);
    const updated = withTranscript(found, { segments: updatedSegments });
    this.meetings = this.meetings.map((meeting) => (meeting.id === id ? updated : meeting));
    return updated;
  }

  /**
   * Sets or clears (via `undefined`) `speakerNames`, mirroring the
   * `exactOptionalPropertyTypes` pattern used by `withFolder`: clearing
   * removes the key entirely rather than assigning `undefined` to it.
   */
  private withSpeakerNames(
    meeting: Meeting,
    speakerNames: Readonly<Record<string, string>> | undefined,
  ): Meeting {
    const { speakerNames: _previous, ...withoutSpeakerNames } = meeting;
    void _previous;
    return speakerNames !== undefined ? { ...withoutSpeakerNames, speakerNames } : withoutSpeakerNames;
  }

  override async export(id: MeetingId, format: MeetingExportFormat, dest: string): Promise<void> {
    void id;
    void format;
    void dest;
  }

  /** Test helper: replace the in-memory meeting collection. */
  seed(meetings: readonly Meeting[]): void {
    this.meetings = meetings;
  }
}
