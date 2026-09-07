import { Injectable, inject } from '@angular/core';

import { TemplateRepositoryPort } from '../../core/ports/template-repository.port';

/** Persists a per-template prompt override and resolves the normalized prompt. */
@Injectable()
export class SetTemplatePromptUseCase {
  private readonly templates = inject(TemplateRepositoryPort);

  async set(name: string, prompt: string): Promise<string> {
    return this.templates.setPrompt(name, prompt);
  }
}
