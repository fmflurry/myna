import { Injectable } from '@angular/core';

import type { ModelsStatus } from '../../core/models/models-status.model';
import { ModelsStatusPort } from '../../core/ports/models-status.port';
import { mapModelsStatusDtoToDomain } from '../mappers/models-status.mapper';
import { invokeCommand } from './ipc';

/** `ModelsStatusPort` implementation backed by the Tauri IPC command surface. */
@Injectable()
export class TauriModelsStatusAdapter extends ModelsStatusPort {
  override async status(): Promise<ModelsStatus> {
    const dto = await invokeCommand('models_status', {});
    return mapModelsStatusDtoToDomain(dto);
  }
}
