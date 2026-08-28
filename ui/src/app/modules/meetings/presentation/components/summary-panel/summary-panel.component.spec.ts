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
});
