import { Injectable } from '@angular/core';

import type { SummaryTemplate } from '../../core/models/summary-template.model';
import { TemplateRepositoryPort } from '../../core/ports/template-repository.port';

const DEFAULT_TEMPLATES: readonly SummaryTemplate[] = [
  { name: 'key-points', description: 'Key points summary', prompt: 'Summarize the key points.' },
];

/** In-memory TemplateRepositoryPort implementation for specs and the placeholder providers. */
@Injectable()
export class InMemoryTemplateRepositoryFake extends TemplateRepositoryPort {
  private templates: readonly SummaryTemplate[] = DEFAULT_TEMPLATES;

  override async list(): Promise<readonly SummaryTemplate[]> {
    return this.templates;
  }

  /** Test helper: replace the in-memory template collection. */
  seed(templates: readonly SummaryTemplate[]): void {
    this.templates = templates;
  }
}
