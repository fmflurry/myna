import { Injectable, inject } from '@angular/core';

import type { Meeting } from '../../core/models/meeting.model';
import { MeetingsError } from '../../core/models/recording-state.model';
import { RecorderPort } from '../../core/ports/recorder.port';

@Injectable()
export class StopRecordingUseCase {
  private readonly recorder = inject(RecorderPort);

  async stop(): Promise<Meeting> {
    const snapshot = await this.recorder.state();
    if (snapshot.state !== 'recording') {
      throw new MeetingsError('NOT_RECORDING', 'No recording is in progress to stop.');
    }
    return this.recorder.stop();
  }
}
