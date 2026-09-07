import { Injectable } from '@angular/core';

import type { SummaryTemplate } from '../../core/models/summary-template.model';
import { TemplateRepositoryPort } from '../../core/ports/template-repository.port';
import { mapTemplateDtoToDomain } from '../mappers/template.mapper';
import { invokeCommand } from './ipc';

/** `TemplateRepositoryPort` implementation backed by the Tauri IPC command surface. */
@Injectable()
export class TauriTemplateRepositoryAdapter extends TemplateRepositoryPort {
  override async list(): Promise<readonly SummaryTemplate[]> {
    const dtos = await invokeCommand('list_templates', {});
    return dtos.map(mapTemplateDtoToDomain);
  }

  override async getPrompt(name: string): Promise<string> {
    return invokeCommand('get_template_prompt', { name });
  }

  override async setPrompt(name: string, prompt: string): Promise<string> {
    return invokeCommand('set_template_prompt', { name, prompt });
  }

  override async resetPrompt(name: string): Promise<void> {
    await invokeCommand('reset_template_prompt', { name });
  }
}
