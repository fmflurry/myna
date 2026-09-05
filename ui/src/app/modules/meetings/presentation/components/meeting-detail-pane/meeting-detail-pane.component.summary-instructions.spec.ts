import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { SummaryInstructionsDraft } from '../../../core/models/summary-instructions.model';
import type { SummaryTemplate } from '../../../core/models/summary-template.model';
import { MeetingDetailPaneComponent } from './meeting-detail-pane.component';
import { RegenerateInstructionsDialogComponent } from '../regenerate-instructions-dialog/regenerate-instructions-dialog.component';
import { SummaryInstructionsEditorComponent } from '../summary-instructions-editor/summary-instructions-editor.component';

/**
 * The per-request instructions editor as mounted by the detail pane: it
 * renders in the `generate` branch of the summary column, receives the
 * ACTIVE tab's draft from the (meeting, template) map, and re-emits edits
 * tagged with that template. The pane stays dumb — no facade anywhere here.
 */
describe('MeetingDetailPaneComponent summary instructions', () => {
  const templates: SummaryTemplate[] = [
    { name: 'key-points', description: 'Key points', prompt: 'p' },
    { name: 'decisions', description: 'Decisions', prompt: 'p' },
  ];

  const meeting: Meeting = {
    id: toMeetingId('m1'),
    title: 'Standup',
    createdAt: new Date(2026, 7, 27, 14, 2),
    durationSec: 32 * 60,
    transcript: { segments: [] },
    summaries: [],
    archived: false,
    hasAudio: false, hasSystemTrack: false,
    droppedAudioChunks: 0,
  };

  const createFixture = () => {
    const fixture = TestBed.createComponent(MeetingDetailPaneComponent);
    fixture.componentRef.setInput('modelsReady', true);
    fixture.componentRef.setInput('recordingState', 'idle');
    fixture.componentRef.setInput('captureSource', 'microphone');
    fixture.componentRef.setInput('templates', templates);
    fixture.componentRef.setInput('selectedSummaryLanguage', 'en');
    fixture.componentRef.setInput('meeting', meeting);
    fixture.detectChanges();
    return fixture;
  };

  const editorOf = (fixture: ReturnType<typeof createFixture>): SummaryInstructionsEditorComponent | undefined =>
    fixture.debugElement.query(By.directive(SummaryInstructionsEditorComponent))?.componentInstance;

  const createHasSummaryFixture = () => {
    const withSummary: Meeting = {
      ...meeting,
      summaries: [
        { template: 'key-points', markdown: '# Old', createdAt: new Date(), language: 'en', stale: false },
      ],
    };
    const fixture = TestBed.createComponent(MeetingDetailPaneComponent);
    fixture.componentRef.setInput('modelsReady', true);
    fixture.componentRef.setInput('recordingState', 'idle');
    fixture.componentRef.setInput('captureSource', 'microphone');
    fixture.componentRef.setInput('templates', templates);
    fixture.componentRef.setInput('selectedSummaryLanguage', 'en');
    fixture.componentRef.setInput('meeting', withSummary);
    fixture.detectChanges();
    fixture.componentInstance.selectTab('key-points');
    fixture.detectChanges();
    return fixture;
  };

  const openGenerateDialog = (fixture: ReturnType<typeof createFixture>): void => {
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.generate-button');
    expect(button).toBeTruthy();
    button.click();
    fixture.detectChanges();
  };

  const generateDialogOf = (fixture: ReturnType<typeof createFixture>): HTMLElement | null =>
    fixture.nativeElement.querySelector('app-regenerate-instructions-dialog [role="dialog"]');

  const dialogOf = (fixture: ReturnType<typeof createFixture>): HTMLElement | null =>
    fixture.nativeElement.querySelector('app-regenerate-instructions-dialog [role="dialog"]');

  const openDialog = (fixture: ReturnType<typeof createFixture>): void => {
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.regenerate-button');
    expect(button).toBeTruthy();
    button.click();
    fixture.detectChanges();
  };

  it('renders no editor on the Transcript tab', () => {
    const fixture = createFixture();

    expect(editorOf(fixture)).toBeUndefined();
  });

  it('generate branch with dialog closed shows zero inline editors and zero dialogs', () => {
    const fixture = createFixture();

    fixture.componentInstance.selectTab('key-points');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.generate')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.generate-button')).toBeTruthy();
    expect(generateDialogOf(fixture)).toBeNull();
    expect(fixture.debugElement.queryAll(By.directive(SummaryInstructionsEditorComponent)).length).toBe(0);
    expect(
      (fixture.nativeElement.querySelector('.generate-button') as HTMLButtonElement).getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('Generate opens the dialog with Generate copy, role=dialog, aria-modal, and hint', () => {
    const fixture = createFixture();
    fixture.componentInstance.selectTab('key-points');
    fixture.detectChanges();

    openGenerateDialog(fixture);

    expect(fixture.debugElement.query(By.directive(RegenerateInstructionsDialogComponent))).toBeTruthy();
    const dialog = generateDialogOf(fixture);
    expect(dialog).toBeTruthy();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(fixture.nativeElement.querySelector('app-regenerate-instructions-dialog .confirm')?.textContent).toContain(
      'Generate',
    );
    expect(
      fixture.nativeElement.querySelector('#regenerate-instructions-title')?.textContent,
    ).toContain('Generate summary');
    expect(fixture.nativeElement.querySelector('app-regenerate-instructions-dialog .hint')?.textContent).toContain(
      'egenerate',
    );
    expect(
      (fixture.nativeElement.querySelector('.generate-button') as HTMLButtonElement).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(fixture.debugElement.queryAll(By.directive(SummaryInstructionsEditorComponent)).length).toBe(1);
  });

  it('Generate confirms exactly once for the active tab then closes the dialog', () => {
    const fixture = createFixture();
    fixture.componentInstance.selectTab('key-points');
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.summarizeRequested.subscribe((template) => emitted.push(template));

    openGenerateDialog(fixture);
    expect(emitted).toEqual([]);
    (fixture.nativeElement.querySelector('app-regenerate-instructions-dialog .confirm') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(emitted).toEqual(['key-points']);
    expect(generateDialogOf(fixture)).toBeNull();
  });

  it('Generate Esc closes the dialog with zero summarizeRequested', () => {
    const fixture = createFixture();
    fixture.componentInstance.selectTab('key-points');
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.summarizeRequested.subscribe((template) => emitted.push(template));

    openGenerateDialog(fixture);
    expect(generateDialogOf(fixture)).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(emitted).toEqual([]);
    expect(generateDialogOf(fixture)).toBeNull();
  });

  it('Generate backdrop click closes the dialog with zero summarizeRequested', () => {
    const fixture = createFixture();
    fixture.componentInstance.selectTab('key-points');
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.summarizeRequested.subscribe((template) => emitted.push(template));

    openGenerateDialog(fixture);
    const backdrop: HTMLElement = fixture.nativeElement.querySelector(
      'app-regenerate-instructions-dialog .regenerate-instructions-backdrop',
    );
    expect(backdrop).toBeTruthy();
    backdrop.click();
    fixture.detectChanges();

    expect(emitted).toEqual([]);
    expect(generateDialogOf(fixture)).toBeNull();
  });

  it('Generate Cancel closes the dialog with zero summarizeRequested and returns focus to Generate', () => {
    const fixture = createFixture();
    fixture.componentInstance.selectTab('key-points');
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.summarizeRequested.subscribe((template) => emitted.push(template));

    openGenerateDialog(fixture);
    (fixture.nativeElement.querySelector('app-regenerate-instructions-dialog .cancel') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(emitted).toEqual([]);
    expect(generateDialogOf(fixture)).toBeNull();
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('.generate-button'));
  });

  it('Generate confirm returns focus to Generate', () => {
    const fixture = createFixture();
    fixture.componentInstance.selectTab('key-points');
    fixture.detectChanges();
    fixture.componentInstance.summarizeRequested.subscribe(() => undefined);

    openGenerateDialog(fixture);
    (fixture.nativeElement.querySelector('app-regenerate-instructions-dialog .confirm') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('.generate-button'));
  });

  it('busy Generate stays disabled with a reason and never arms the dialog', () => {
    const fixture = createFixture();
    fixture.componentInstance.selectTab('key-points');
    fixture.componentRef.setInput('summarizing', true);
    fixture.componentRef.setInput('summarizingKey', { template: 'meeting-notes', language: 'en' });
    fixture.detectChanges();

    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.generate-button');
    expect(button).toBeTruthy();
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('meeting-notes');
    expect(fixture.nativeElement.querySelector('.generate .busy-hint')?.textContent).toContain('meeting-notes');
    button.click();
    fixture.detectChanges();
    expect(generateDialogOf(fixture)).toBeNull();
    expect(fixture.debugElement.queryAll(By.directive(SummaryInstructionsEditorComponent)).length).toBe(0);
  });

  it('passes the ACTIVE tab draft from the map, and the default when the tab has none', () => {
    const fixture = createFixture();
    const keyPointsDraft: SummaryInstructionsDraft = { text: 'Focus on pricing', includeGeneral: false };
    fixture.componentRef.setInput('summaryInstructionDrafts', new Map([['key-points', keyPointsDraft]]));
    fixture.componentInstance.selectTab('key-points');
    fixture.detectChanges();
    openGenerateDialog(fixture);

    expect(editorOf(fixture)?.draft()).toEqual(keyPointsDraft);

    fixture.componentInstance.selectTab('decisions');
    fixture.detectChanges();
    openGenerateDialog(fixture);

    expect(editorOf(fixture)?.draft()).toEqual({ text: '', includeGeneral: true });
  });

  it('re-emits editor changes tagged with the active template', () => {
    const fixture = createFixture();
    fixture.componentInstance.selectTab('decisions');
    fixture.detectChanges();
    openGenerateDialog(fixture);
    const emitted: { template: string; draft: SummaryInstructionsDraft }[] = [];
    fixture.componentInstance.summaryInstructionDraftChanged.subscribe((change) => emitted.push(change));

    editorOf(fixture)!.draftChanged.emit({ text: 'Only outcomes', includeGeneral: true });

    expect(emitted).toEqual([{ template: 'decisions', draft: { text: 'Only outcomes', includeGeneral: true } }]);
  });

  it('passes a whitespace-collapsed, truncated guidelines preview to the editor', () => {
    const fixture = createFixture();
    const long = `${'a'.repeat(120)} b`;
    fixture.componentRef.setInput('summaryGuidelines', long);
    fixture.componentInstance.selectTab('key-points');
    fixture.detectChanges();
    openGenerateDialog(fixture);

    const preview = editorOf(fixture)!.guidelinesPreview();
    expect(preview).toBe(`${'a'.repeat(80)}…`);
    expect(preview).not.toContain('\n');
  });

  it('has-summary with dialog closed shows zero inline editors and zero dialogs', () => {
    const fixture = createHasSummaryFixture();

    expect(fixture.nativeElement.querySelector('.regenerate-button')).toBeTruthy();
    expect(dialogOf(fixture)).toBeNull();
    expect(fixture.debugElement.queryAll(By.directive(SummaryInstructionsEditorComponent)).length).toBe(0);
    expect(fixture.nativeElement.querySelector('.regenerate-confirm')).toBeNull();
  });

  it('opens the dialog via Regenerate with role=dialog, aria-modal, and hint', () => {
    const fixture = createHasSummaryFixture();

    openDialog(fixture);

    expect(fixture.debugElement.query(By.directive(RegenerateInstructionsDialogComponent))).toBeTruthy();
    const dialog = dialogOf(fixture);
    expect(dialog).toBeTruthy();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(
      fixture.nativeElement.querySelector('app-regenerate-instructions-dialog .hint')?.textContent,
    ).toContain('Regenerate');
    expect(
      (fixture.nativeElement.querySelector('.regenerate-button') as HTMLButtonElement).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(fixture.debugElement.queryAll(By.directive(SummaryInstructionsEditorComponent)).length).toBe(1);
  });

  it('confirms exactly once for the active tab then closes the dialog', () => {
    const fixture = createHasSummaryFixture();
    const emitted: string[] = [];
    fixture.componentInstance.regenerateRequested.subscribe((template) => emitted.push(template));

    openDialog(fixture);
    (fixture.nativeElement.querySelector('app-regenerate-instructions-dialog .confirm') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(emitted).toEqual(['key-points']);
    expect(dialogOf(fixture)).toBeNull();
    expect(fixture.nativeElement.querySelector('.regenerate-confirm')).toBeNull();
  });

  it('Esc closes the dialog with zero regenerateRequested', () => {
    const fixture = createHasSummaryFixture();
    const emitted: string[] = [];
    fixture.componentInstance.regenerateRequested.subscribe((template) => emitted.push(template));

    openDialog(fixture);
    expect(dialogOf(fixture)).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(emitted).toEqual([]);
    expect(dialogOf(fixture)).toBeNull();
  });

  it('backdrop click closes the dialog with zero regenerateRequested', () => {
    const fixture = createHasSummaryFixture();
    const emitted: string[] = [];
    fixture.componentInstance.regenerateRequested.subscribe((template) => emitted.push(template));

    openDialog(fixture);
    const backdrop: HTMLElement = fixture.nativeElement.querySelector(
      'app-regenerate-instructions-dialog .regenerate-instructions-backdrop',
    );
    expect(backdrop).toBeTruthy();
    backdrop.click();
    fixture.detectChanges();

    expect(emitted).toEqual([]);
    expect(dialogOf(fixture)).toBeNull();
  });

  it('Cancel closes the dialog with zero regenerateRequested and returns focus to Regenerate', () => {
    const fixture = createHasSummaryFixture();
    const emitted: string[] = [];
    fixture.componentInstance.regenerateRequested.subscribe((template) => emitted.push(template));

    openDialog(fixture);
    (fixture.nativeElement.querySelector('app-regenerate-instructions-dialog .cancel') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(emitted).toEqual([]);
    expect(dialogOf(fixture)).toBeNull();
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('.regenerate-button'));
  });

  it('confirm returns focus to Regenerate', () => {
    const fixture = createHasSummaryFixture();
    fixture.componentInstance.regenerateRequested.subscribe(() => undefined);

    openDialog(fixture);
    (fixture.nativeElement.querySelector('app-regenerate-instructions-dialog .confirm') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('.regenerate-button'));
  });

  it('disables the dialog confirm while busy with aria-busy and a reason title on Regenerate', () => {
    const fixture = createHasSummaryFixture();
    fixture.componentRef.setInput('summarizing', true);
    fixture.componentRef.setInput('summarizingKey', { template: 'meeting-notes', language: 'en' });
    fixture.detectChanges();

    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.regenerate-button');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.title).toContain('meeting-notes');
  });
});
