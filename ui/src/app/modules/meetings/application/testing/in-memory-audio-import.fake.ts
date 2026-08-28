import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { toMeetingId } from '../../core/models/meeting.model';
import { AudioImportPort, type ImportProgress } from '../../core/ports/audio-import.port';

/** In-memory AudioImportPort implementation for specs and the placeholder providers. */
@Injectable()
export class InMemoryAudioImportFake extends AudioImportPort {
  private readonly progressSubject = new Subject<ImportProgress>();

  private nextMeeting: Meeting = {
    id: toMeetingId('imported-meeting'),
    title: 'Imported meeting',
    createdAt: new Date(),
    durationSec: 0,
    summaries: [],
    archived: false,
    hasAudio: true,
  };
  private importError: Error | undefined;
  private lastImportedPath: string | undefined;
  private lastImportedTitle: string | undefined;
  private lastRetranscribedId: MeetingId | undefined;
  private lastRetranscribedPath: string | undefined;
  private cancelCallCount = 0;

  override async importFile(path: string, title?: string): Promise<Meeting> {
    this.lastImportedPath = path;
    this.lastImportedTitle = title;
    if (this.importError) {
      throw this.importError;
    }
    return this.nextMeeting;
  }

  override async retranscribe(id: MeetingId, path?: string): Promise<Meeting> {
    this.lastRetranscribedId = id;
    this.lastRetranscribedPath = path;
    if (this.importError) {
      throw this.importError;
    }
    return this.nextMeeting;
  }

  override async cancel(): Promise<void> {
    this.cancelCallCount += 1;
    if (this.importError) {
      throw this.importError;
    }
  }

  override progress(): Observable<ImportProgress> {
    return this.progressSubject.asObservable();
  }

  /** Test helper: push a synthetic import progress event. */
  emitProgress(progress: ImportProgress): void {
    this.progressSubject.next(progress);
  }

  /** Test helper: control the Meeting returned by importFile()/retranscribe(). */
  seed(meeting: Meeting): void {
    this.nextMeeting = meeting;
  }

  /** Test helper: make importFile()/retranscribe() reject with the given error. */
  seedError(error: Error): void {
    this.importError = error;
  }

  /** Test helper: the `path` argument passed to the most recent importFile() call. */
  getLastImportedPath(): string | undefined {
    return this.lastImportedPath;
  }

  /** Test helper: the `title` argument passed to the most recent importFile() call. */
  getLastImportedTitle(): string | undefined {
    return this.lastImportedTitle;
  }

  /** Test helper: the `id` argument passed to the most recent retranscribe() call. */
  getLastRetranscribedId(): MeetingId | undefined {
    return this.lastRetranscribedId;
  }

  /** Test helper: the `path` argument passed to the most recent retranscribe() call. */
  getLastRetranscribedPath(): string | undefined {
    return this.lastRetranscribedPath;
  }

  /** Test helper: how many times cancel() has been called. */
  getCancelCallCount(): number {
    return this.cancelCallCount;
  }
}
