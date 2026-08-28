import type { SummaryTemplate } from '../models/summary-template.model';

/** Maps onto the frozen Rust command list_templates. */
export abstract class TemplateRepositoryPort {
  abstract list(): Promise<readonly SummaryTemplate[]>;
}
