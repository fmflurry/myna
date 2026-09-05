import { TestBed } from '@angular/core/testing';

import type { SummaryInstructionsDraft } from '../../../core/models/summary-instructions.model';
import { SummaryInstructionsEditorComponent } from './summary-instructions-editor.component';

describe('SummaryInstructionsEditorComponent', () => {
  const defaultDraft: SummaryInstructionsDraft = { text: '', includeGeneral: true };

  const createFixture = (draft: SummaryInstructionsDraft = defaultDraft, guidelinesPreview = '') => {
    const fixture = TestBed.createComponent(SummaryInstructionsEditorComponent);
    fixture.componentRef.setInput('draft', draft);
    fixture.componentRef.setInput('guidelinesPreview', guidelinesPreview);
    fixture.detectChanges();
    return fixture;
  };

  const textareaOf = (fixture: ReturnType<typeof createFixture>): HTMLTextAreaElement | null =>
    fixture.nativeElement.querySelector('.instructions-input');

  it('is collapsed when the draft is still the default one', () => {
    const fixture = createFixture();

    expect(textareaOf(fixture)).toBeNull();
    expect(fixture.nativeElement.querySelector('.include-general')).toBeNull();
  });

  it('is expanded when a focus-text draft exists', () => {
    const fixture = createFixture({ text: 'Focus on pricing', includeGeneral: true });

    expect(textareaOf(fixture)?.value).toBe('Focus on pricing');
  });

  it('is expanded when general guidelines were turned off (a non-default choice)', () => {
    const fixture = createFixture({ text: '', includeGeneral: false });

    expect(textareaOf(fixture)).toBeTruthy();
  });

  it('expands when the toggle is clicked', () => {
    const fixture = createFixture();

    fixture.nativeElement.querySelector('.toggle').click();
    fixture.detectChanges();

    expect(textareaOf(fixture)).toBeTruthy();
  });

  it('emits the trimmed draft on blur after typing', () => {
    const fixture = createFixture();
    fixture.nativeElement.querySelector('.toggle').click();
    fixture.detectChanges();
    const emitted: SummaryInstructionsDraft[] = [];
    fixture.componentInstance.draftChanged.subscribe((draft) => emitted.push(draft));

    const textarea = textareaOf(fixture)!;
    textarea.value = '  Focus on decisions  ';
    textarea.dispatchEvent(new Event('input'));
    textarea.dispatchEvent(new Event('blur'));

    expect(emitted).toEqual([{ text: 'Focus on decisions', includeGeneral: true }]);
  });

  it('does not emit on blur when the text is unchanged', () => {
    const fixture = createFixture({ text: 'Focus on pricing', includeGeneral: true });
    const emitted: SummaryInstructionsDraft[] = [];
    fixture.componentInstance.draftChanged.subscribe((draft) => emitted.push(draft));

    const textarea = textareaOf(fixture)!;
    textarea.dispatchEvent(new Event('blur'));

    expect(emitted).toEqual([]);
  });

  it('emits immediately when the general-guidelines checkbox is toggled', () => {
    const fixture = createFixture();
    fixture.nativeElement.querySelector('.toggle').click();
    fixture.detectChanges();
    const emitted: SummaryInstructionsDraft[] = [];
    fixture.componentInstance.draftChanged.subscribe((draft) => emitted.push(draft));

    const checkbox: HTMLInputElement = fixture.nativeElement.querySelector('.include-general input');
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));

    expect(emitted).toEqual([{ text: '', includeGeneral: false }]);
  });

  it('shows the guidelines hint when the checkbox is on and a preview exists', () => {
    const fixture = createFixture(defaultDraft, 'Be concise. Use bullet points.');
    fixture.nativeElement.querySelector('.toggle').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.guidelines-hint').textContent).toContain('Be concise. Use bullet points.');
  });

  it('hides the hint when the checkbox is off', () => {
    const fixture = createFixture({ text: 'Focus', includeGeneral: false }, 'Be concise.');

    expect(fixture.nativeElement.querySelector('.guidelines-hint')).toBeNull();
  });

  it('hides the hint when there are no general guidelines (never placeholder text)', () => {
    const fixture = createFixture(defaultDraft, '');
    fixture.nativeElement.querySelector('.toggle').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.guidelines-hint')).toBeNull();
  });

  it('hides the Remove affordance when the draft is still the default one', () => {
    const fixture = createFixture();
    fixture.nativeElement.querySelector('.toggle').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.remove-instructions')).toBeNull();
  });

  it('emits the default draft when Remove is clicked on a non-default draft', () => {
    const fixture = createFixture({ text: 'Focus on pricing', includeGeneral: true });
    const emitted: SummaryInstructionsDraft[] = [];
    fixture.componentInstance.draftChanged.subscribe((draft) => emitted.push(draft));

    const remove: HTMLButtonElement = fixture.nativeElement.querySelector('.remove-instructions');
    expect(remove).toBeTruthy();
    remove.click();

    expect(emitted).toEqual([{ text: '', includeGeneral: true }]);
  });

  it('shows Remove when only the guidelines toggle is non-default', () => {
    const fixture = createFixture({ text: '', includeGeneral: false });

    expect(fixture.nativeElement.querySelector('.remove-instructions')).toBeTruthy();
  });

  it('drops a stale local edit when the draft input switches (tab/meeting change)', () => {
    const fixture = createFixture();
    fixture.nativeElement.querySelector('.toggle').click();
    fixture.detectChanges();

    const textarea = textareaOf(fixture)!;
    textarea.value = 'typed for the old draft';
    textarea.dispatchEvent(new Event('input'));

    fixture.componentRef.setInput('draft', { text: 'stored for the new draft', includeGeneral: true });
    fixture.detectChanges();

    expect(textareaOf(fixture)?.value).toBe('stored for the new draft');
  });

  it('forceExpanded shows input with zero .toggle', () => {
    const fixture = TestBed.createComponent(SummaryInstructionsEditorComponent);
    fixture.componentRef.setInput('draft', defaultDraft);
    fixture.componentRef.setInput('forceExpanded', true);
    fixture.detectChanges();

    expect(textareaOf(fixture)).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.toggle')).toBeNull();
  });

  it('forceExpanded keeps input visible with zero .toggle on a non-default draft', () => {
    const fixture = TestBed.createComponent(SummaryInstructionsEditorComponent);
    fixture.componentRef.setInput('draft', { text: 'Focus on pricing', includeGeneral: true });
    fixture.componentRef.setInput('forceExpanded', true);
    fixture.detectChanges();

    expect(textareaOf(fixture)?.value).toBe('Focus on pricing');
    expect(fixture.nativeElement.querySelector('.toggle')).toBeNull();
  });
});
