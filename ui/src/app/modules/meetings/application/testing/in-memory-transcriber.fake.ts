import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

import type { MeetingId } from '../../core/models/meeting.model';
import { emptyTranscript, withSegment, type Transcript } from '../../core/models/transcript.model';
import {
  TranscriberPort,
  type TranscriptFinal,
  type TranscriptPartial,
} from '../../core/ports/transcriber.port';

/** In-memory TranscriberPort implementation for specs and the placeholder providers. */
@Injectable()
export class InMemoryTranscriberFake extends TranscriberPort {
  private readonly partialSubject = new Subject<TranscriptPartial>();
  private readonly finalSubject = new Subject<TranscriptFinal>();
  private transcript: Transcript = emptyTranscript();

  override partials(): Observable<TranscriptPartial> {
    return this.partialSubject.asObservable();
  }

  override finals(): Observable<TranscriptFinal> {
    return this.finalSubject.asObservable();
  }

  override async transcriptFor(id: MeetingId): Promise<Transcript> {
    void id;
    return this.transcript;
  }

  override async liveTranscriptFor(id: MeetingId): Promise<Transcript> {
    // The fake has no persisted-vs-live distinction: `emitFinal` already
    // folds each final into the same running transcript, mirroring how the
    // real backend's journal replays the same segments a live session has
    // finalized so far.
    void id;
    return this.transcript;
  }

  /** Test helper: push a synthetic in-flight partial transcript. */
  emitPartial(partial: TranscriptPartial): void {
    this.partialSubject.next(partial);
  }

  /** Test helper: push a synthetic finalized transcript segment. */
  emitFinal(final: TranscriptFinal): void {
    this.transcript = withSegment(this.transcript, final.segment);
    this.finalSubject.next(final);
  }
}
