import { Injectable } from '@angular/core';

import type { SummaryTemplate } from '../../core/models/summary-template.model';
import { MeetingsError } from '../../core/models/recording-state.model';
import { TemplateRepositoryPort } from '../../core/ports/template-repository.port';

const DEFAULT_TEMPLATES: readonly SummaryTemplate[] = [
  { name: 'key-points', description: 'Key points summary', prompt: 'Summarize the key points.' },
];

/** In-memory TemplateRepositoryPort implementation for specs and the placeholder providers. */
@Injectable()
export class InMemoryTemplateRepositoryFake extends TemplateRepositoryPort {
  private templates: readonly SummaryTemplate[] = DEFAULT_TEMPLATES;
  private readonly overrides = new Map<string, string>();

  override async list(): Promise<readonly SummaryTemplate[]> {
    return this.templates;
  }

  override async getPrompt(name: string): Promise<string> {
    const override = this.overrides.get(name);
    if (override !== undefined) {
      return override;
    }
    const builtin = this.templates.find((candidate) => candidate.name === name);
    if (builtin === undefined) {
      throw new MeetingsError('NOT_FOUND', `No template '${name}'.`);
    }
    return builtin.prompt;
  }

  override async setPrompt(name: string, prompt: string): Promise<string> {
    const known = this.templates.some((candidate) => candidate.name === name);
    if (!known) {
      throw new MeetingsError('NOT_FOUND', `No template '${name}'.`);
    }
    this.overrides.set(name, prompt);
    return prompt;
  }

  override async resetPrompt(name: string): Promise<void> {
    const known = this.templates.some((candidate) => candidate.name === name);
    if (!known) {
      throw new MeetingsError('NOT_FOUND', `No template '${name}'.`);
    }
    this.overrides.delete(name);
  }

  /** Test helper: replace the in-memory template collection. */
  seed(templates: readonly SummaryTemplate[]): void {
    this.templates = templates;
  }
}
