import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import type { SummaryInstructionsDraft } from '../../../core/models/summary-instructions.model';
import { RegenerateInstructionsDialogComponent } from './regenerate-instructions-dialog.component';
import { SummaryInstructionsEditorComponent } from '../summary-instructions-editor/summary-instructions-editor.component';

/**
 * A11y + decision contract for the regenerate confirmation modal: it must
 * expose `role="dialog"` + `aria-modal`, surface the contextual hint, emit
 * exactly one decision (`confirmed` XOR `cancelled`), and never steal the
 * sidebar's Esc handling (a `.modal` ancestor, see `closeSidebarOnEscape`).
 */
describe('RegenerateInstructionsDialogComponent', () => {
  const draft: SummaryInstructionsDraft = { text: 'Focus on pricing', includeGeneral: true };

  const createFixture = (overrides: {
    readonly draft?: SummaryInstructionsDraft;
    readonly guidelinesPreview?: string;
    readonly hint?: string;
    readonly confirmDisabled?: boolean;
    readonly templateLabel?: string;
    readonly dialogTitlePrefix?: string;
    readonly description?: string;
    readonly confirmLabel?: string;
    readonly focusReturnSelector?: string;
  } = {}) => {
    const fixture = TestBed.createComponent(RegenerateInstructionsDialogComponent);
    fixture.componentRef.setInput('draft', overrides.draft ?? draft);
    fixture.componentRef.setInput('guidelinesPreview', overrides.guidelinesPreview ?? '');
    fixture.componentRef.setInput('hint', overrides.hint ?? 'Regenerate hint');
    fixture.componentRef.setInput('confirmDisabled', overrides.confirmDisabled ?? false);
    fixture.componentRef.setInput('templateLabel', overrides.templateLabel ?? 'Key points');
    if (overrides.dialogTitlePrefix !== undefined) {
      fixture.componentRef.setInput('dialogTitlePrefix', overrides.dialogTitlePrefix);
    }
    if (overrides.description !== undefined) {
      fixture.componentRef.setInput('description', overrides.description);
    }
    if (overrides.confirmLabel !== undefined) {
      fixture.componentRef.setInput('confirmLabel', overrides.confirmLabel);
    }
    if (overrides.focusReturnSelector !== undefined) {
      fixture.componentRef.setInput('focusReturnSelector', overrides.focusReturnSelector);
    }
    fixture.detectChanges();
    return fixture;
  };

  const dialogOf = (fixture: ReturnType<typeof createFixture>): HTMLElement | null =>
    fixture.nativeElement.querySelector('[role="dialog"]');

  it('exposes role=dialog with aria-modal, title, and description', () => {
    const fixture = createFixture();

    const dialog = dialogOf(fixture);
    expect(dialog).toBeTruthy();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('regenerate-instructions-title');
    expect(dialog?.getAttribute('aria-describedby')).toBe('regenerate-instructions-description');
    expect(fixture.nativeElement.querySelector('#regenerate-instructions-title')?.textContent).toContain(
      'Key points',
    );
    expect(fixture.nativeElement.querySelector('#regenerate-instructions-description')?.textContent).toContain(
      'Adjust the instructions',
    );
  });

  it('hides the template suffix when no label is given', () => {
    const fixture = createFixture({ templateLabel: '' });

    expect(fixture.nativeElement.querySelector('#regenerate-instructions-title')?.textContent).not.toContain('—');
  });

  it('shows the contextual hint and hides it when empty', () => {
    const withHint = createFixture({ hint: 'Regenerate using your instructions' });
    expect(withHint.nativeElement.querySelector('.hint')?.textContent).toContain('your instructions');

    const withoutHint = createFixture({ hint: '' });
    expect(withoutHint.nativeElement.querySelector('.hint')).toBeNull();
  });

  it('passes the draft through to the force-expanded editor and re-emits edits', () => {
    const fixture = createFixture();
    const emitted: SummaryInstructionsDraft[] = [];
    fixture.componentInstance.draftChanged.subscribe((next) => emitted.push(next));

    const editor = fixture.debugElement.query(By.directive(SummaryInstructionsEditorComponent));
    expect(editor).toBeTruthy();
    const editorInstance = editor.componentInstance as SummaryInstructionsEditorComponent;
    expect(editorInstance.draft()).toEqual(draft);
    expect(editorInstance.forceExpanded()).toBe(true);

    editorInstance.draftChanged.emit({ text: 'Focus on risks', includeGeneral: false });
    expect(emitted).toEqual([{ text: 'Focus on risks', includeGeneral: false }]);
  });

  it('emits confirmed via the Regenerate button with zero cancels', () => {
    const fixture = createFixture();
    const confirmed: void[][] = [];
    const cancelled: void[][] = [];
    fixture.componentInstance.confirmed.subscribe(() => confirmed.push([]));
    fixture.componentInstance.cancelled.subscribe(() => cancelled.push([]));

    const confirm: HTMLButtonElement = fixture.nativeElement.querySelector('.actions .confirm');
    expect(confirm.textContent).toContain('Regenerate');
    confirm.click();

    expect(confirmed.length).toBe(1);
    expect(cancelled).toEqual([]);
  });

  it('disables confirm while a generation run is already in flight', () => {
    const fixture = createFixture({ confirmDisabled: true });

    expect((fixture.nativeElement.querySelector('.actions .confirm') as HTMLButtonElement).disabled).toBe(true);
  });

  it('cancels via the Cancel button with zero confirms', () => {
    const fixture = createFixture();
    const confirmed: void[][] = [];
    const cancelled: void[][] = [];
    fixture.componentInstance.confirmed.subscribe(() => confirmed.push([]));
    fixture.componentInstance.cancelled.subscribe(() => cancelled.push([]));

    (fixture.nativeElement.querySelector('.actions .cancel') as HTMLButtonElement).click();

    expect(cancelled.length).toBe(1);
    expect(confirmed).toEqual([]);
  });

  it('cancels on Escape with zero confirms', () => {
    const fixture = createFixture();
    const confirmed: void[][] = [];
    const cancelled: void[][] = [];
    fixture.componentInstance.confirmed.subscribe(() => confirmed.push([]));
    fixture.componentInstance.cancelled.subscribe(() => cancelled.push([]));

    fixture.componentInstance.onEscape();

    expect(cancelled.length).toBe(1);
    expect(confirmed).toEqual([]);
  });

  it('cancels on backdrop click only when target===currentTarget', () => {
    const fixture = createFixture();
    const cancelled: void[][] = [];
    fixture.componentInstance.cancelled.subscribe(() => cancelled.push([]));

    const backdrop: HTMLElement = fixture.nativeElement.querySelector('.regenerate-instructions-backdrop');
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cancelled.length).toBe(1);

    const dialog = dialogOf(fixture)!;
    const innerClick = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(innerClick, 'target', { value: dialog });
    Object.defineProperty(innerClick, 'currentTarget', { value: backdrop });
    fixture.componentInstance.onBackdropClick(innerClick);
    expect(cancelled.length).toBe(1);
  });

  it('cancels on backdrop Enter/Space only when target===currentTarget', () => {
    const fixture = createFixture();
    const cancelled: void[][] = [];
    fixture.componentInstance.cancelled.subscribe(() => cancelled.push([]));

    const backdrop: HTMLElement = fixture.nativeElement.querySelector('.regenerate-instructions-backdrop');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(enter, 'target', { value: backdrop });
    Object.defineProperty(enter, 'currentTarget', { value: backdrop });
    fixture.componentInstance.onBackdropKeydown(enter);
    expect(cancelled.length).toBe(1);

    const dialog = dialogOf(fixture)!;
    const innerEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(innerEnter, 'target', { value: dialog });
    Object.defineProperty(innerEnter, 'currentTarget', { value: backdrop });
    fixture.componentInstance.onBackdropKeydown(innerEnter);
    expect(cancelled.length).toBe(1);
  });

  it('carries a .modal ancestor so the narrow-sidebar Esc guard defers to it', () => {
    // Contract with closeSidebarOnEscape (meetings-shell.page.sidebar-narrow.support.ts):
    // it bails out when event.target sits inside a modal ancestor. The
    // shell-level specs assert the guard itself; here we assert our side of
    // the contract — the dialog must provide that ancestor.
    const fixture = createFixture();
    const dialog = dialogOf(fixture)!;

    expect(dialog.closest('.modal')).not.toBeNull();
  });

  it('moves focus into the dialog on open for keyboard users', () => {
    const fixture = createFixture();
    fixture.detectChanges();

    const dialog = dialogOf(fixture)!;
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('defaults render the Regenerate copy', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('#regenerate-instructions-title')?.textContent).toContain(
      'Regenerate summary',
    );
    expect(fixture.nativeElement.querySelector('#regenerate-instructions-description')?.textContent).toContain(
      'Adjust the instructions below, then confirm to regenerate this summary.',
    );
    expect(fixture.nativeElement.querySelector('.actions .confirm')?.textContent).toContain('Regenerate');
    expect(fixture.componentInstance.dialogTitlePrefix()).toBe('Regenerate summary');
    expect(fixture.componentInstance.description()).toBe(
      'Adjust the instructions below, then confirm to regenerate this summary.',
    );
    expect(fixture.componentInstance.confirmLabel()).toBe('Regenerate');
    expect(fixture.componentInstance.focusReturnSelector()).toBe('.regenerate-button');
  });

  it('Generate inputs render the Generate copy', () => {
    const fixture = createFixture({
      dialogTitlePrefix: 'Generate summary',
      description: 'Adjust the instructions below, then confirm to generate this summary.',
      confirmLabel: 'Generate',
      focusReturnSelector: '.generate-button',
    });

    expect(fixture.nativeElement.querySelector('#regenerate-instructions-title')?.textContent).toContain(
      'Generate summary',
    );
    expect(fixture.nativeElement.querySelector('#regenerate-instructions-title')?.textContent).not.toContain(
      'Regenerate summary',
    );
    expect(fixture.nativeElement.querySelector('#regenerate-instructions-description')?.textContent).toContain(
      'Adjust the instructions below, then confirm to generate this summary.',
    );
    expect(fixture.nativeElement.querySelector('.actions .confirm')?.textContent).toContain('Generate');
    expect(fixture.componentInstance.focusReturnSelector()).toBe('.generate-button');
  });

  it('keeps the editor force-expanded with zero toggles', () => {
    const fixture = createFixture();

    const editor = fixture.debugElement.query(By.directive(SummaryInstructionsEditorComponent));
    expect((editor.componentInstance as SummaryInstructionsEditorComponent).forceExpanded()).toBe(true);
    expect(fixture.nativeElement.querySelectorAll('.toggle').length).toBe(0);
  });
});
