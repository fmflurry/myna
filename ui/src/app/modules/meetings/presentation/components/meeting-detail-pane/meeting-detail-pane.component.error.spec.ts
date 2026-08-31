import { TestBed } from '@angular/core/testing';

import type { MeetingsErrorInfo } from '../../../application/stores/meetings.store';
import type { SummaryTemplate } from '../../../core/models/summary-template.model';
import { MeetingDetailPaneComponent } from './meeting-detail-pane.component';

/**
 * RED-confirmed regression for the "nothing happened at all" silent-failure
 * report: `error()` reaches this component correctly, but the OLD template
 * only rendered `<app-error-state>` inside the `@else` (meeting-selected)
 * branch of a three-way `@if (!modelsReady()) {…} @else if (!meeting()) {…}
 * @else {…}` chain. When an import is rejected before any placeholder
 * meeting exists, `meeting()` stays `undefined`, the welcome-panel branch
 * renders instead, and the error was silently dropped — never rendered
 * anywhere.
 *
 * Every pre-existing spec in this file (and its siblings) seeds a selected
 * meeting before asserting on error rendering, so none of them ever
 * exercised `meeting() === undefined` AND `error()` set at the same time —
 * the exact gap this file closes. See `meeting-detail-pane.component.html`
 * for the fix: the error is now hoisted out of the branch chain entirely.
 */
describe('MeetingDetailPaneComponent error visibility with no meeting selected', () => {
  const templates: SummaryTemplate[] = [{ name: 'key-points', description: 'Key points', prompt: 'p' }];
  const pathError: MeetingsErrorInfo = {
    code: 'PATH',
    message: 'source path is inside the meetings root and would be overwritten by the import',
  };

  const createFixture = (error: MeetingsErrorInfo | undefined) => {
    const fixture = TestBed.createComponent(MeetingDetailPaneComponent);
    fixture.componentRef.setInput('modelsReady', true);
    fixture.componentRef.setInput('recordingState', 'idle');
    fixture.componentRef.setInput('captureSource', 'microphone');
    fixture.componentRef.setInput('templates', templates);
    fixture.componentRef.setInput('selectedSummaryLanguage', 'en');
    fixture.componentRef.setInput('error', error);
    fixture.detectChanges();
    return fixture;
  };

  it('renders app-error-state when no meeting is selected and an error is set (was previously dropped)', () => {
    const fixture = createFixture(pathError);

    const errorState = fixture.nativeElement.querySelector('app-error-state');
    expect(errorState).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('The selected file location is invalid.');
  });

  it('still renders the welcome panel underneath the hoisted error', () => {
    const fixture = createFixture(pathError);

    expect(fixture.nativeElement.querySelector('app-welcome-panel')).toBeTruthy();
  });

  it('renders no error-state when error is unset and no meeting is selected', () => {
    const fixture = createFixture(undefined);

    expect(fixture.nativeElement.querySelector('app-error-state')).toBeNull();
  });

  it('re-emits retryRequested from the hoisted error-state', () => {
    const fixture = createFixture(pathError);
    const emitted: number[] = [];
    fixture.componentInstance.retryRequested.subscribe(() => emitted.push(1));

    fixture.nativeElement.querySelector('app-error-state .retry').click();

    expect(emitted).toEqual([1]);
  });
});
