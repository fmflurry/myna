import { Injectable, inject } from '@angular/core';

import { RecorderPort } from '../../core/ports/recorder.port';

@Injectable()
export class CancelRecordingUseCase {
  private readonly recorder = inject(RecorderPort);

  async cancel(): Promise<void> {
    // The port resolves with the backend's `{ accepted: true }` ack; the
    // use case keeps its void contract and discards it — the idle transition
    // rides the `recording://state` event, never the command result.
    await this.recorder.cancel();
  }
}
