import { Injectable, inject } from '@angular/core';

import type { SystemAudioStatus } from '../../core/models/capture-source.model';
import { RecorderPort } from '../../core/ports/recorder.port';

@Injectable()
export class CheckSystemAudioUseCase {
  private readonly recorder = inject(RecorderPort);

  async status(): Promise<SystemAudioStatus> {
    return this.recorder.systemAudioStatus();
  }

  async request(): Promise<SystemAudioStatus> {
    return this.recorder.requestSystemAudioPermission();
  }
}
