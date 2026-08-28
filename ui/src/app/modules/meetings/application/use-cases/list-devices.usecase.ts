import { Injectable, inject } from '@angular/core';

import type { AudioDevice } from '../../core/models/audio-device.model';
import { RecorderPort } from '../../core/ports/recorder.port';

@Injectable()
export class ListDevicesUseCase {
  private readonly recorder = inject(RecorderPort);

  async list(): Promise<readonly AudioDevice[]> {
    return this.recorder.listDevices();
  }

  async default(): Promise<AudioDevice> {
    return this.recorder.defaultDevice();
  }
}
