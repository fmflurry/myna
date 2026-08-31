import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { toMeetingId } from '../../core/models/meeting.model';
import { AudioImportPort, type ImportProgress } from '../../core/ports/audio-import.port';

/** In-memory AudioImportPort implementation for specs and the placeholder providers. */
@Injectable()
export class InMemoryAudioImportFake extends AudioImportPort {
  /** Reassignable (not `readonly`): {@link emitProgressStreamFailure} swaps in a fresh Subject after an error. */
  private progressSubject = new Subject<ImportProgress>();
  /** Reassignable (not `readonly`): {@link emitErrorEventsStreamFailure} swaps in a fresh Subject after an error. */
  private errorEventsSubject = new Subject<{ readonly code: string; readonly message: string }>();

  private nextMeeting: Meeting = {
    id: toMeetingId('imported-meeting'),
    title: 'Imported meeting',
    createdAt: new Date(),
    durationSec: 0,
    summaries: [],
    archived: false,
    hasAudio: true,
    hasSystemTrack: true,
    droppedAudioChunks: 0,
  };
  private importError: Error | undefined;
  private lastImportedPath: string | undefined;
  private lastImportedTitle: string | undefined;
  private lastRetranscribedId: MeetingId | undefined;
  private lastRetranscribedPath: string | undefined;
  private lastDiarizedId: MeetingId | undefined;
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

  override async diarize(id: MeetingId): Promise<Meeting> {
    this.lastDiarizedId = id;
    if (this.importError) {
      throw this.importError;
    }
    return this.nextMeeting;
  }

  override progress(): Observable<ImportProgress> {
    return this.progressSubject.asObservable();
  }

  /**
   * `AudioImportPort.errors()`: the `error://occurred` channel (finding 6).
   * NOTE: `AudioImportPort` does not declare this method yet — the GREEN
   * implementation must add it (see GREEN spec). Until then this is a
   * fake-only method exercised directly by tests via the concrete type.
   */
  override errors(): Observable<{ readonly code: string; readonly message: string }> {
    return this.errorEventsSubject.asObservable();
  }

  /** Test helper: push a synthetic import progress event. */
  emitProgress(progress: ImportProgress): void {
    this.progressSubject.next(progress);
  }

  /**
   * Test helper: simulate the `progress()` OBSERVABLE itself failing (e.g. a
   * transient `listen()` rejection) — NOT a normal progress payload. Swaps in
   * a fresh Subject afterwards so a subsequent `progress()` re-subscription
   * (as a bounded `retry()` performs) can succeed, mirroring a real transient
   * IPC hiccup self-healing on the next `listen()` call.
   */
  emitProgressStreamFailure(error: unknown): void {
    const failed = this.progressSubject;
    this.progressSubject = new Subject<ImportProgress>();
    failed.error(error);
  }

  /** Test helper: push a synthetic `error://occurred` payload. */
  emitErrorEvent(code: string, message: string): void {
    this.errorEventsSubject.next({ code, message });
  }

  /** Test helper: simulate the `errors()` OBSERVABLE itself failing transiently; see {@link emitProgressStreamFailure}. */
  emitErrorEventsStreamFailure(error: unknown): void {
    const failed = this.errorEventsSubject;
    this.errorEventsSubject = new Subject<{ readonly code: string; readonly message: string }>();
    failed.error(error);
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

  /** Test helper: the `id` argument passed to the most recent diarize() call. */
  getLastDiarizedId(): MeetingId | undefined {
    return this.lastDiarizedId;
  }
}
