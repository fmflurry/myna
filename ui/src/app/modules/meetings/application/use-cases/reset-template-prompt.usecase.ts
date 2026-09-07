import { Injectable, inject } from '@angular/core';

import { TemplateRepositoryPort } from '../../core/ports/template-repository.port';

/** Deletes a per-template prompt override, restoring the built-in prompt. Idempotent. */
@Injectable()
export class ResetTemplatePromptUseCase {
  private readonly templates = inject(TemplateRepositoryPort);

  async reset(name: string): Promise<void> {
    await this.templates.resetPrompt(name);
  }
}
