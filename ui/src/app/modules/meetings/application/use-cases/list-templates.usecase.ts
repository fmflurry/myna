import { Injectable, inject } from '@angular/core';

import type { SummaryTemplate } from '../../core/models/summary-template.model';
import { TemplateRepositoryPort } from '../../core/ports/template-repository.port';

@Injectable()
export class ListTemplatesUseCase {
  private readonly templates = inject(TemplateRepositoryPort);

  async list(): Promise<readonly SummaryTemplate[]> {
    return this.templates.list();
  }
}
