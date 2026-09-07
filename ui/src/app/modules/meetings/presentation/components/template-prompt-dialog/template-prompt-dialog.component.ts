import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  computed,
  inject,
  input,
  linkedSignal,
  output,
} from '@angular/core';

import { validatePromptText } from '../meeting-detail-pane/meeting-detail-pane.component.support';

/** Max prompt size in Unicode scalar values — mirrors Rust `MAX_TEMPLATE_PROMPT_CHARS`. */
export const MAX_TEMPLATE_PROMPT_CHARS = 12000;

const DEFAULT_PLACEHOLDER_HELP = 'Placeholders: {title} {duration} {transcript} (required) {language}.';

/**
 * Dumb per-template prompt editor modal. Reuses the regenerate-dialog modal
 * contract: the host carries the `modal` class so the narrow-sidebar Escape
 * guard defers to it, focus moves into the dialog on open and returns to the
 * template tab's cogwheel on close.
 *
 * The owning pane decides WHEN to show it and what each output means: `saved`
 * carries the edited prompt to persist, `resetRequested` restores the
 * built-in, `cancelled` disarms without persisting. Save is armed only for a
 * changed, valid draft — client-side mirror of the server rules
 * (`{transcript}` required, no unknown placeholders, at most 12000 chars).
 */
@Component({
  selector: 'app-template-prompt-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './template-prompt-dialog.component.html',
  styleUrl: './template-prompt-dialog.component.scss',
  host: { class: 'modal' },
})
export class TemplatePromptDialogComponent implements AfterViewInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Template slug (`key-points`); drives the focus-return selector. */
  readonly templateName = input.required<string>();
  /** Human-readable label shown in the title. */
  readonly templateLabel = input('');
  /** Built-in description shown as the subtitle; hidden when empty. */
  readonly templateDescription = input('');
  /** Built-in prompt; compared against the effective prompt to gate Reset. */
  readonly builtinPrompt = input('');
  /** Prompt the textarea edits — the override when customized, else the built-in. */
  readonly effectivePrompt = input.required<string>();
  /** Placeholder help shown under the textarea; defaults to the placeholder list. */
  readonly placeholderHelp = input('');
  /** Disables Save/Reset while a prompt load/save/reset is in flight. */
  readonly confirmDisabled = input(false);
  /** Server-side failure from the last save/reset; hidden when empty. */
  readonly error = input('');

  /** The edited prompt to persist. */
  readonly saved = output<string>();
  readonly resetRequested = output<void>();
  readonly cancelled = output<void>();

  /** Local draft seeded from `effectivePrompt`; re-seeds on template switch or reset. */
  protected readonly draft = linkedSignal(() => this.effectivePrompt());

  protected readonly maxChars = MAX_TEMPLATE_PROMPT_CHARS;
  protected readonly charCount = computed(() => Array.from(this.draft()).length);
  protected readonly tooLong = computed(() => this.charCount() > MAX_TEMPLATE_PROMPT_CHARS);
  protected readonly validationError = computed(() => validatePromptText(this.draft()));
  protected readonly inlineError = computed(() =>
    this.tooLong()
      ? `Prompt must be at most ${MAX_TEMPLATE_PROMPT_CHARS} characters.`
      : this.validationError(),
  );
  protected readonly unchanged = computed(() => this.draft() === this.effectivePrompt());
  protected readonly customized = computed(() => this.effectivePrompt() !== this.builtinPrompt());
  /** Save is armed only for a changed, valid draft while no request is in flight. */
  protected readonly saveDisabled = computed(
    () => this.confirmDisabled() || this.unchanged() || this.inlineError() !== undefined,
  );
  protected readonly resetDisabled = computed(() => this.confirmDisabled() || !this.customized());
  protected readonly helpText = computed(() =>
    this.placeholderHelp() === '' ? DEFAULT_PLACEHOLDER_HELP : this.placeholderHelp(),
  );

  /** Moves keyboard focus inside the dialog so it is operable without a pointer. */
  ngAfterViewInit(): void {
    const field = this.host.nativeElement.querySelector('.prompt-input');
    if (field instanceof HTMLTextAreaElement) {
      field.focus();
    }
  }

  /** Returns focus to the template tab's cogwheel; a no-op in isolation where none exists. */
  ngOnDestroy(): void {
    if (typeof document === 'undefined') {
      return;
    }
    const trigger = document.querySelector(`.template-settings[data-template="${this.templateName()}"]`);
    if (trigger instanceof HTMLButtonElement) {
      trigger.focus();
    }
  }

  /** Bound on the component's host, so it's only listening while this dialog is actually mounted. */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.cancelled.emit();
  }

  onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.cancelled.emit();
    }
  }

  onBackdropKeydown(event: KeyboardEvent): void {
    if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      this.cancelled.emit();
    }
  }

  onInput(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
  }

  /** Emits the draft only when armed; the template keeps the button disabled otherwise. */
  save(): void {
    if (this.saveDisabled()) {
      return;
    }
    this.saved.emit(this.draft());
  }

  requestReset(): void {
    if (this.resetDisabled()) {
      return;
    }
    this.resetRequested.emit();
  }

  cancel(): void {
    this.cancelled.emit();
  }
}
