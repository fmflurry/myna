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

  describe('markdown viewer — view formatted / edit raw (RED)', () => {
    it('view renders a heading element, not the raw marker', () => {
      const fixture = TestBed.createComponent(SummaryPanelComponent);
      fixture.componentRef.setInput('markdown', '# Key points');
      fixture.detectChanges();

      const view: HTMLElement = fixture.nativeElement.querySelector('.markdown');
      expect(view).toBeTruthy();
      expect(view.querySelector('h1')).toBeTruthy();
      expect(view.querySelector('h1')?.textContent).toContain('Key points');
      expect(view.textContent).not.toContain('# Key points');
    });

    it('view renders list items and strong, not markers', () => {
      const fixture = TestBed.createComponent(SummaryPanelComponent);
      fixture.componentRef.setInput('markdown', '- one\n- **two**');
      fixture.detectChanges();

      const view: HTMLElement = fixture.nativeElement.querySelector('.markdown');
      const items = view.querySelectorAll('li');
      expect(items.length).toBe(2);
      expect(view.querySelector('strong')?.textContent).toContain('two');
      expect(view.textContent).not.toContain('**two**');
    });

    it('edit mode shows the raw markdown in the textarea and hides the formatted view', () => {
      const fixture = TestBed.createComponent(SummaryPanelComponent);
      fixture.componentRef.setInput('markdown', '# Points\n- **one**');
      fixture.componentRef.setInput('editable', true);
      fixture.detectChanges();

      fixture.componentInstance.beginEdit();
      fixture.detectChanges();

      const textarea: HTMLTextAreaElement =
        fixture.nativeElement.querySelector('.summary-input');
      expect(textarea.value).toBe('# Points\n- **one**');
      expect(fixture.nativeElement.querySelector('.markdown')).toBeNull();
    });

    it('Done round-trips the raw draft, and the updated view renders formatted', () => {
      const fixture = TestBed.createComponent(SummaryPanelComponent);
      fixture.componentRef.setInput('markdown', '# Original');
      fixture.componentRef.setInput('editable', true);
      fixture.detectChanges();
      const emitted: string[] = [];
      fixture.componentInstance.summaryEdited.subscribe((markdown) => emitted.push(markdown));

      fixture.componentInstance.beginEdit();
      fixture.detectChanges();
      const textarea: HTMLTextAreaElement =
        fixture.nativeElement.querySelector('.summary-input');
      textarea.value = '# Edited **bold**';
      textarea.dispatchEvent(new Event('input'));
      fixture.nativeElement.querySelector('.done').click();
      fixture.detectChanges();

      expect(emitted).toEqual(['# Edited **bold**']);
      fixture.componentRef.setInput('markdown', emitted[0]);
      fixture.detectChanges();

      const view: HTMLElement = fixture.nativeElement.querySelector('.markdown');
      expect(view.querySelector('h1')).toBeTruthy();
      expect(view.querySelector('strong')?.textContent).toContain('bold');
      expect(view.textContent).not.toContain('**bold**');
    });

    it('Cancel discards the draft and returns to the formatted view', () => {
      const fixture = TestBed.createComponent(SummaryPanelComponent);
      fixture.componentRef.setInput('markdown', '# Points');
      fixture.componentRef.setInput('editable', true);
      fixture.detectChanges();

      fixture.componentInstance.beginEdit();
      fixture.detectChanges();
      const textarea: HTMLTextAreaElement =
        fixture.nativeElement.querySelector('.summary-input');
      textarea.value = '# Discarded';
      textarea.dispatchEvent(new Event('input'));
      fixture.nativeElement.querySelector('.discard').click();
      fixture.detectChanges();

      const view: HTMLElement = fixture.nativeElement.querySelector('.markdown');
      expect(view.querySelector('h1')?.textContent).toContain('Points');
      expect(view.textContent).not.toContain('# Discarded');
    });

    it('Escape discards the draft and returns to the formatted view', () => {
      const fixture = TestBed.createComponent(SummaryPanelComponent);
      fixture.componentRef.setInput('markdown', '# Points');
      fixture.componentRef.setInput('editable', true);
      fixture.detectChanges();

      fixture.componentInstance.beginEdit();
      fixture.detectChanges();
      const textarea: HTMLTextAreaElement =
        fixture.nativeElement.querySelector('.summary-input');
      textarea.value = '# Discarded';
      textarea.dispatchEvent(new Event('input'));
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      fixture.detectChanges();

      const view: HTMLElement = fixture.nativeElement.querySelector('.markdown');
      expect(view.querySelector('h1')?.textContent).toContain('Points');
    });

    it('strips script tags while still rendering surrounding markdown', () => {
      const fixture = TestBed.createComponent(SummaryPanelComponent);
      fixture.componentRef.setInput('markdown', '# Title\n<script>alert(1)</script>');
      fixture.detectChanges();

      const view: HTMLElement = fixture.nativeElement.querySelector('.markdown');
      expect(view.querySelector('h1')?.textContent).toContain('Title');
      expect(view.querySelector('script')).toBeNull();
      expect(view.innerHTML).not.toContain('<script>');
    });

    it('neutralizes javascript: link targets', () => {
      const fixture = TestBed.createComponent(SummaryPanelComponent);
      fixture.componentRef.setInput('markdown', '[click me](javascript:alert(1))');
      fixture.detectChanges();

      const anchor: HTMLAnchorElement | null =
        fixture.nativeElement.querySelector('.markdown a');
      expect(anchor).toBeTruthy();
      expect(anchor?.getAttribute('href')?.toLowerCase().startsWith('javascript:')).toBe(false);
    });
  });
});
