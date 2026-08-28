import { Injectable, inject } from '@angular/core';

import type { AudioSource } from '../../core/models/audio-source.model';
import { RecorderPort } from '../../core/ports/recorder.port';

/** Maps onto the frozen Rust command list_audio_sources. */
@Injectable()
export class ListAudioSourcesUseCase {
  private readonly recorder = inject(RecorderPort);

  async list(): Promise<readonly AudioSource[]> {
    return this.recorder.listAudioSources();
  }
}
