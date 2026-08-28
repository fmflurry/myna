import { Injectable, inject } from '@angular/core';

import { RecorderPort } from '../../core/ports/recorder.port';

@Injectable()
export class CancelRecordingUseCase {
  private readonly recorder = inject(RecorderPort);

  async cancel(): Promise<void> {
    return this.recorder.cancel();
  }
}
