import { TestBed } from '@angular/core/testing';

import {
  MAX_TEMPLATE_PROMPT_CHARS,
  TemplatePromptDialogComponent,
} from './template-prompt-dialog.component';

const BUILTIN = 'Summarize {transcript} for {title}.';
const EFFECTIVE = 'Summarize {transcript} for {title} in {language}.';

/**
 * A11y + decision contract for the per-template prompt editor modal: it must
 * expose `role="dialog"` + `aria-modal`, seed its textarea from the effective
 * prompt, arm Save only for a changed valid draft, and emit exactly one
 * decision (`saved` XOR `resetRequested` XOR `cancelled`). Carries the same
 * `.modal`-ancestor Escape contract as the regenerate dialog.
 */
describe('TemplatePromptDialogComponent', () => {
  const createFixture = (overrides: {
    readonly templateName?: string;
    readonly templateLabel?: string;
    readonly templateDescription?: string;
    readonly builtinPrompt?: string;
    readonly effectivePrompt?: string;
    readonly placeholderHelp?: string;
    readonly confirmDisabled?: boolean;
    readonly error?: string;
  } = {}) => {
    const fixture = TestBed.createComponent(TemplatePromptDialogComponent);
    fixture.componentRef.setInput('templateName', overrides.templateName ?? 'key-points');
    fixture.componentRef.setInput('templateLabel', overrides.templateLabel ?? 'Key points');
    fixture.componentRef.setInput('templateDescription', overrides.templateDescription ?? 'Key points');
    fixture.componentRef.setInput('builtinPrompt', overrides.builtinPrompt ?? BUILTIN);
    fixture.componentRef.setInput('effectivePrompt', overrides.effectivePrompt ?? EFFECTIVE);
    if (overrides.placeholderHelp !== undefined) {
      fixture.componentRef.setInput('placeholderHelp', overrides.placeholderHelp);
    }
    fixture.componentRef.setInput('confirmDisabled', overrides.confirmDisabled ?? false);
    fixture.componentRef.setInput('error', overrides.error ?? '');
    fixture.detectChanges();
    return fixture;
  };

  const dialogOf = (fixture: ReturnType<typeof createFixture>): HTMLElement | null =>
    fixture.nativeElement.querySelector('[role="dialog"]');

  const textareaOf = (fixture: ReturnType<typeof createFixture>): HTMLTextAreaElement =>
    fixture.nativeElement.querySelector('.prompt-input');

  const typePrompt = (fixture: ReturnType<typeof createFixture>, value: string): void => {
    textareaOf(fixture).value = value;
    textareaOf(fixture).dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };

  it('exposes role=dialog with aria-modal, title, and description', () => {
    const fixture = createFixture();

    const dialog = dialogOf(fixture);
    expect(dialog).toBeTruthy();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('template-prompt-title');
    expect(dialog?.getAttribute('aria-describedby')).toBe('template-prompt-description');
    expect(fixture.nativeElement.querySelector('#template-prompt-title')?.textContent).toContain(
      'Key points',
    );
    expect(fixture.nativeElement.querySelector('#template-prompt-description')?.textContent).toContain(
      'Key points',
    );
  });

  it('falls back to the template slug when no label is given', () => {
    const fixture = createFixture({ templateLabel: '' });

    expect(fixture.nativeElement.querySelector('#template-prompt-title')?.textContent).toContain(
      'key-points',
    );
  });

  it('seeds the textarea from the effective prompt with rows=12', () => {
    const fixture = createFixture();

    expect(textareaOf(fixture).value).toBe(EFFECTIVE);
    expect(textareaOf(fixture).getAttribute('rows')).toBe('12');
  });

  it('shows the placeholder hint with the required {transcript} marker', () => {
    const fixture = createFixture();

    const hint: string = fixture.nativeElement.querySelector('.hint').textContent;
    expect(hint).toContain('{title}');
    expect(hint).toContain('{transcript}');
    expect(hint).toContain('{language}');
  });

  it('shows the character count against the 12000 limit', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('.char-count')?.textContent).toContain(
      `${MAX_TEMPLATE_PROMPT_CHARS}`,
    );
  });

  it('notes that only future summaries are affected', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('.note')?.textContent).toContain(
      'Applies to future summaries',
    );
  });

  it('disables Save while the draft is unchanged', () => {
    const fixture = createFixture();

    expect((fixture.nativeElement.querySelector('.actions .confirm') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('rejects a draft without {transcript} with inline validation and a disabled Save', () => {
    const fixture = createFixture();
    typePrompt(fixture, 'Summarize for {title}.');

    expect(fixture.nativeElement.querySelector('.error')?.textContent).toContain('{transcript}');
    expect((fixture.nativeElement.querySelector('.actions .confirm') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('rejects unknown placeholders with inline validation', () => {
    const fixture = createFixture();
    typePrompt(fixture, 'Summarize {transcript} with {vibes}.');

    expect(fixture.nativeElement.querySelector('.error')?.textContent).toContain('{vibes}');
    expect((fixture.nativeElement.querySelector('.actions .confirm') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('rejects a draft over 12000 characters', () => {
    const fixture = createFixture();
    typePrompt(fixture, `{transcript} ${'a'.repeat(MAX_TEMPLATE_PROMPT_CHARS)}`);

    expect(fixture.nativeElement.querySelector('.error')?.textContent).toContain('12000');
    expect((fixture.nativeElement.querySelector('.actions .confirm') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('arms Save for a changed valid draft and emits it with zero resets/cancels', () => {
    const fixture = createFixture();
    const saved: string[] = [];
    const resets: void[][] = [];
    const cancels: void[][] = [];
    fixture.componentInstance.saved.subscribe((prompt) => saved.push(prompt));
    fixture.componentInstance.resetRequested.subscribe(() => resets.push([]));
    fixture.componentInstance.cancelled.subscribe(() => cancels.push([]));
    typePrompt(fixture, 'Brief {transcript} for {title}.');

    const save: HTMLButtonElement = fixture.nativeElement.querySelector('.actions .confirm');
    expect(save.disabled).toBe(false);
    save.click();

    expect(saved).toEqual(['Brief {transcript} for {title}.']);
    expect(resets).toEqual([]);
    expect(cancels).toEqual([]);
  });

  it('disables Save while a request is in flight', () => {
    const fixture = createFixture({ confirmDisabled: true });
    typePrompt(fixture, 'Brief {transcript} for {title}.');

    expect((fixture.nativeElement.querySelector('.actions .confirm') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('surfaces a server-side error without touching the inline validation', () => {
    const fixture = createFixture({ error: 'Prompt rejected by the server.' });

    expect(fixture.nativeElement.querySelector('.server-error')?.textContent).toContain(
      'rejected by the server',
    );
  });

  it('emits resetRequested via Reset to built-in with zero saves', () => {
    const fixture = createFixture({ effectivePrompt: 'Custom {transcript}.' });
    const saved: string[] = [];
    const resets: void[][] = [];
    fixture.componentInstance.saved.subscribe((prompt) => saved.push(prompt));
    fixture.componentInstance.resetRequested.subscribe(() => resets.push([]));

    (fixture.nativeElement.querySelector('.actions .reset') as HTMLButtonElement).click();

    expect(resets.length).toBe(1);
    expect(saved).toEqual([]);
  });

  it('disables Reset when the effective prompt is already the built-in', () => {
    const fixture = createFixture({ builtinPrompt: BUILTIN, effectivePrompt: BUILTIN });

    expect((fixture.nativeElement.querySelector('.actions .reset') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('cancels via the Cancel button with zero saves', () => {
    const fixture = createFixture();
    const saved: string[] = [];
    const cancels: void[][] = [];
    fixture.componentInstance.saved.subscribe((prompt) => saved.push(prompt));
    fixture.componentInstance.cancelled.subscribe(() => cancels.push([]));

    (fixture.nativeElement.querySelector('.actions .cancel') as HTMLButtonElement).click();

    expect(cancels.length).toBe(1);
    expect(saved).toEqual([]);
  });

  it('cancels on Escape with zero saves', () => {
    const fixture = createFixture();
    const cancels: void[][] = [];
    fixture.componentInstance.cancelled.subscribe(() => cancels.push([]));

    fixture.componentInstance.onEscape();

    expect(cancels.length).toBe(1);
  });

  it('cancels on backdrop click only when target===currentTarget', () => {
    const fixture = createFixture();
    const cancels: void[][] = [];
    fixture.componentInstance.cancelled.subscribe(() => cancels.push([]));

    const backdrop: HTMLElement = fixture.nativeElement.querySelector('.template-prompt-backdrop');
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cancels.length).toBe(1);

    const dialog = dialogOf(fixture);
    const innerClick = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(innerClick, 'target', { value: dialog });
    Object.defineProperty(innerClick, 'currentTarget', { value: backdrop });
    fixture.componentInstance.onBackdropClick(innerClick);
    expect(cancels.length).toBe(1);
  });

  it('carries a .modal ancestor so the narrow-sidebar Esc guard defers to it', () => {
    const fixture = createFixture();

    expect(dialogOf(fixture)?.closest('.modal')).not.toBeNull();
  });

  it('moves focus into the dialog on open for keyboard users', () => {
    const fixture = createFixture();
    fixture.detectChanges();

    expect(dialogOf(fixture)?.contains(document.activeElement)).toBe(true);
  });
});
