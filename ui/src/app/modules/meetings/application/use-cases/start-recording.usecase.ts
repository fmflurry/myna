import { Injectable, inject } from '@angular/core';

import type { CaptureSource } from '../../core/models/capture-source.model';
import type { Meeting } from '../../core/models/meeting.model';
import { MeetingsError } from '../../core/models/recording-state.model';
import { RecorderPort } from '../../core/ports/recorder.port';

@Injectable()
export class StartRecordingUseCase {
  private readonly recorder = inject(RecorderPort);

  async with(
    title: string,
    deviceName?: string,
    source?: CaptureSource,
    systemSource?: string,
  ): Promise<Meeting> {
    const state = await this.recorder.state();
    if (state !== 'idle') {
      throw new MeetingsError('BUSY', 'A recording is already in progress.');
    }
    return this.recorder.start(title, deviceName, source, systemSource);
  }
}
