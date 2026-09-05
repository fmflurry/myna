import { TestBed } from '@angular/core/testing';

import { SummaryPanelComponent } from './summary-panel.component';

describe('SummaryPanelComponent', () => {
  it('shows an empty state when there is no summary and it is not generating', () => {
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', '');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.empty')).toBeTruthy();
  });

  it('shows a cancel button while generating', () => {
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', '');
    fixture.componentRef.setInput('generating', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.cancel')).toBeTruthy();
  });

  it('announces the generating state as an accessible, busy status with a visible spinner', () => {
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', '');
    fixture.componentRef.setInput('generating', true);
    fixture.detectChanges();

    const status = fixture.nativeElement.querySelector('.status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.querySelector('.spinner')).toBeTruthy();
  });

  it('emits cancelClicked when the cancel button is clicked', () => {
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', '');
    fixture.componentRef.setInput('generating', true);
    fixture.detectChanges();
    const emitted: void[] = [];
    fixture.componentInstance.cancelClicked.subscribe(() => emitted.push(undefined));

    fixture.nativeElement.querySelector('.cancel').click();

    expect(emitted.length).toBe(1);
  });

  it('renders streamed markdown', () => {
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', '# Key points\n- one');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.markdown').textContent).toContain('Key points');
  });

  it('shows a distinct loading state, not the empty state, while a persisted summary is being fetched', () => {
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', '');
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.status.loading')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.empty')).toBeNull();
  });

  it('does not show the loading state once markdown has arrived', () => {
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', '# Points');
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.status.loading')).toBeNull();
    expect(fixture.nativeElement.querySelector('.markdown').textContent).toContain('Points');
  });

  it('shows the stale banner when the summary was generated from a previous transcript, without hiding the summary', () => {
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', '# Points');
    fixture.componentRef.setInput('stale', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.stale-banner')?.textContent).toContain(
      'Generated from a previous transcript',
    );
    expect(fixture.nativeElement.querySelector('.markdown').textContent).toContain('Points');
  });

  it('does not show the stale banner when the summary is up to date', () => {
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', '# Points');
    fixture.componentRef.setInput('stale', false);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.stale-banner')).toBeNull();
  });

  it('does not show the stale banner when there is no markdown to show yet, even if stale is true', () => {
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', '');
    fixture.componentRef.setInput('stale', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.stale-banner')).toBeNull();
  });

  it('hides the Edit button by default — read-only unless the parent opts in', () => {
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', '# Points');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.edit')).toBeNull();
    expect(fixture.nativeElement.querySelector('.markdown')).toBeTruthy();
  });

  it('owns no Edit button — the toolbar forwards into beginEdit() instead', () => {
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', '# Points');
    fixture.componentRef.setInput('editable', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.edit')).toBeNull();
    fixture.componentInstance.beginEdit();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.summary-input')).toBeTruthy();
  });

  it('beginEdit() is a no-op unless the parent opts into editable', () => {
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', '# Points');
    fixture.detectChanges();

    fixture.componentInstance.beginEdit();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.summary-input')).toBeNull();
  });

  it('entering edit mode shows a textarea pre-filled with the full current markdown', () => {
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', '# Points\n- one\n- two');
    fixture.componentRef.setInput('editable', true);
    fixture.detectChanges();

    fixture.componentInstance.beginEdit();
    fixture.detectChanges();

    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('.summary-input');
    expect(textarea).toBeTruthy();
    expect(textarea.value).toBe('# Points\n- one\n- two');
    expect(fixture.nativeElement.querySelector('.markdown')).toBeNull();
  });

  it('Done emits the trimmed markdown only when it changed', () => {
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', '# Points');
    fixture.componentRef.setInput('editable', true);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.summaryEdited.subscribe((markdown) => emitted.push(markdown));

    fixture.componentInstance.beginEdit();
    fixture.detectChanges();
    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('.summary-input');
    textarea.value = '  # Rewritten points  ';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.done').click();
    fixture.detectChanges();

    expect(emitted).toEqual(['# Rewritten points']);
    expect(fixture.nativeElement.querySelector('.summary-input')).toBeNull();
  });

  it('Done emits nothing when the markdown is unchanged, and leaves edit mode', () => {
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', '# Points');
    fixture.componentRef.setInput('editable', true);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.summaryEdited.subscribe((markdown) => emitted.push(markdown));

    fixture.componentInstance.beginEdit();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.done').click();
    fixture.detectChanges();

    expect(emitted).toEqual([]);
    expect(fixture.nativeElement.querySelector('.summary-input')).toBeNull();
    expect(fixture.nativeElement.querySelector('.markdown').textContent).toContain('Points');
  });

  it('Cancel discards the draft and returns to the read-only markdown', () => {
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', '# Points');
    fixture.componentRef.setInput('editable', true);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.summaryEdited.subscribe((markdown) => emitted.push(markdown));

    fixture.componentInstance.beginEdit();
    fixture.detectChanges();
    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('.summary-input');
    textarea.value = '# Discarded';
    textarea.dispatchEvent(new Event('input'));
    fixture.nativeElement.querySelector('.discard').click();
    fixture.detectChanges();

    expect(emitted).toEqual([]);
    expect(fixture.nativeElement.querySelector('.summary-input')).toBeNull();
    expect(fixture.nativeElement.querySelector('.markdown').textContent).toContain('Points');
  });

  it('Escape cancels the draft like the Cancel button', () => {
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', '# Points');
    fixture.componentRef.setInput('editable', true);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.summaryEdited.subscribe((markdown) => emitted.push(markdown));

    fixture.componentInstance.beginEdit();
    fixture.detectChanges();
    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('.summary-input');
    textarea.value = '# Discarded';
    textarea.dispatchEvent(new Event('input'));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    expect(emitted).toEqual([]);
    expect(fixture.nativeElement.querySelector('.summary-input')).toBeNull();
  });

  it('auto-sizes the textarea — its height style is set from the content measurement', async () => {
    // jsdom always reports `scrollHeight` as 0, so shadow the inherited getter
    // with a fixed value simulating content that needs 96px (same technique
    // as the EditableSegmentComponent specs).
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      value: 96,
      configurable: true,
    });
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', '# Points\n- one\n- two\n- three\n- four\n- five');
    fixture.componentRef.setInput('editable', true);
    fixture.detectChanges();
    document.body.appendChild(fixture.nativeElement);

    fixture.componentInstance.beginEdit();
    fixture.detectChanges();
    await fixture.whenStable();

    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('.summary-input');
    expect(textarea.style.height).toBe('96px');

    delete (HTMLTextAreaElement.prototype as { scrollHeight?: unknown }).scrollHeight;
    fixture.nativeElement.remove();
  });
});
