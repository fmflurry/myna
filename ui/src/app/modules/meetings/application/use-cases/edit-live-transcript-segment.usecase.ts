import { Injectable, inject } from '@angular/core';

import type { MeetingId } from '../../core/models/meeting.model';
import type { Transcript } from '../../core/models/transcript.model';
import { TranscriberPort } from '../../core/ports/transcriber.port';

/**
 * Corrects one live (still-recording) journal segment via
 * `TranscriberPort.editLiveSegment`. Facade-only — components never inject a
 * use case directly, they call `MeetingsFacade.editLiveTranscriptSegment`.
 */
@Injectable()
export class EditLiveTranscriptSegmentUseCase {
  private readonly transcriber = inject(TranscriberPort);

  async edit(id: MeetingId, index: number, text: string): Promise<Transcript> {
    return this.transcriber.editLiveSegment(id, index, text);
  }
}
