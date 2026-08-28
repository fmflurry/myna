import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import type { SummaryTemplate } from '../../../core/models/summary-template.model';
import { WelcomePanelComponent } from '../welcome-panel/welcome-panel.component';
import { MeetingDetailPaneComponent } from './meeting-detail-pane.component';

/**
 * RED coverage for replacing the bare `.empty-pane` text with
 * `app-welcome-panel` when no meeting is selected. `welcome-panel.component`
 * does not exist yet, so importing it here is expected to fail module
 * resolution — that IS the RED signal for this whole file (see the sibling
 * `welcome-panel.component.spec.ts` for the component's intended API).
 * Split out of `meeting-detail-pane.component.spec.ts`, which is already at
 * the 400-line cap.
 */
describe('MeetingDetailPaneComponent welcome panel', () => {
  const templates: SummaryTemplate[] = [{ name: 'key-points', description: 'Key points', prompt: 'p' }];

  const createFixture = () => {
    const fixture = TestBed.createComponent(MeetingDetailPaneComponent);
    fixture.componentRef.setInput('modelsReady', true);
    fixture.componentRef.setInput('recordingState', 'idle');
    fixture.componentRef.setInput('captureSource', 'microphone');
    fixture.componentRef.setInput('templates', templates);
    fixture.componentRef.setInput('selectedSummaryLanguage', 'en');
    fixture.detectChanges();
    return fixture;
  };

  it('renders app-welcome-panel instead of the bare empty-pane text when no meeting is selected', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('.empty-pane')).toBeNull();
    expect(fixture.debugElement.query(By.directive(WelcomePanelComponent))).toBeTruthy();
  });

  it('re-emits startRecordingRequested from the welcome panel', () => {
    const fixture = createFixture();
    const emitted: number[] = [];
    fixture.componentInstance.startRecordingRequested.subscribe(() => emitted.push(1));

    const welcomePanel = fixture.debugElement.query(By.directive(WelcomePanelComponent))
      .componentInstance as WelcomePanelComponent;
    welcomePanel.startRecordingRequested.emit();

    expect(emitted).toEqual([1]);
  });

  it('still renders app-onboarding-panel, not the welcome panel, when models are not ready', () => {
    const fixture = TestBed.createComponent(MeetingDetailPaneComponent);
    fixture.componentRef.setInput('modelsReady', false);
    fixture.componentRef.setInput('recordingState', 'idle');
    fixture.componentRef.setInput('captureSource', 'microphone');
    fixture.componentRef.setInput('selectedSummaryLanguage', 'en');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-onboarding-panel')).toBeTruthy();
    expect(fixture.debugElement.query(By.directive(WelcomePanelComponent))).toBeNull();
  });
});
