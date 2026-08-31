import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';

import type { ModelDownloadDone, ModelDownloadProgress } from '../../core/ports/model-initializer.port';
import { ModelInitializerPort } from '../../core/ports/model-initializer.port';
import { invokeCommand, onEvent } from './ipc';

/** `ModelInitializerPort` implementation backed by the Tauri IPC command surface. */
@Injectable()
export class TauriModelInitializerAdapter extends ModelInitializerPort {
  override async start(): Promise<void> {
    await invokeCommand('start_model_download', {});
  }

  override async startDiarization(): Promise<void> {
    await invokeCommand('start_diarization_download', {});
  }

  override async cancel(): Promise<void> {
    await invokeCommand('cancel_model_download', {});
  }

  override progress(): Observable<ModelDownloadProgress> {
    return onEvent('models://progress');
  }

  override done(): Observable<ModelDownloadDone> {
    return onEvent('models://done');
  }
}
