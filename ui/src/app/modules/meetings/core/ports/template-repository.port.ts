import type { SummaryTemplate } from '../models/summary-template.model';

/** Maps onto the frozen Rust commands list_templates, get_template_prompt, set_template_prompt, reset_template_prompt. */
export abstract class TemplateRepositoryPort {
  abstract list(): Promise<readonly SummaryTemplate[]>;
  /**
   * Effective prompt for `name`: the persisted override when one exists,
   * otherwise the built-in template's prompt.
   */
  abstract getPrompt(name: string): Promise<string>;
  /**
   * Persists a per-template prompt override for `name` and resolves the
   * normalized prompt.
   */
  abstract setPrompt(name: string, prompt: string): Promise<string>;
  /**
   * Deletes the persisted prompt override for `name`, restoring the
   * built-in prompt. Idempotent.
   */
  abstract resetPrompt(name: string): Promise<void>;
}
