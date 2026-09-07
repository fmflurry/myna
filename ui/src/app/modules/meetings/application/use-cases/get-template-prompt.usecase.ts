import { Injectable, inject } from '@angular/core';

import { TemplateRepositoryPort } from '../../core/ports/template-repository.port';

/** Reads the effective prompt for a template: the persisted override when one exists, otherwise the built-in prompt. */
@Injectable()
export class GetTemplatePromptUseCase {
  private readonly templates = inject(TemplateRepositoryPort);

  async get(name: string): Promise<string> {
    return this.templates.getPrompt(name);
  }
}
