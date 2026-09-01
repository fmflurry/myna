import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import type { ModelDownloadState } from '../../../application/stores/meetings.store';
import { OnboardingPanelComponent } from '../onboarding-panel/onboarding-panel.component';
import { MeetingDetailPaneComponent } from './meeting-detail-pane.component';

/**
 * Covers the pass-through wiring for the in-app model download: the
 * `modelDownload` input forwarded down to `app-onboarding-panel`, and its
 * `downloadRequested` / `downloadCancelRequested` outputs re-emitted back up
 * to `meetings-shell.page.ts`. Split out of `meeting-detail-pane.component.spec.ts`,
 * which is already at the project's 400-line cap.
 */
describe('MeetingDetailPaneComponent model download', () => {
  const runningDownload: ModelDownloadState = {
    phase: 'running',
    artifact: 'encoder.int8.onnx',
    index: 0,
    total: 3,
    success: false,
    cancelled: false,
    message: null,
  };

  const createFixture = () => {
    const fixture = TestBed.createComponent(MeetingDetailPaneComponent);
    fixture.componentRef.setInput('modelsReady', false);
    fixture.componentRef.setInput('recordingState', 'idle');
    fixture.componentRef.setInput('captureSource', 'microphone');
    fixture.componentRef.setInput('selectedSummaryLanguage', 'en');
    return fixture;
  };

  it('forwards modelDownload to app-onboarding-panel', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('modelDownload', runningDownload);
    fixture.detectChanges();

    const panel = fixture.debugElement.query(By.directive(OnboardingPanelComponent))
      .componentInstance as OnboardingPanelComponent;

    expect(panel.modelDownload()).toEqual(runningDownload);
  });

  it('re-emits downloadRequested from the onboarding panel', () => {
    const fixture = createFixture();
    fixture.detectChanges();
    const emitted: void[] = [];
    fixture.componentInstance.downloadRequested.subscribe(() => emitted.push(undefined));

    const panel = fixture.debugElement.query(By.directive(OnboardingPanelComponent))
      .componentInstance as OnboardingPanelComponent;
    panel.downloadRequested.emit();

    expect(emitted.length).toBe(1);
  });

  it('re-emits downloadCancelRequested from the onboarding panel', () => {
    const fixture = createFixture();
    fixture.detectChanges();
    const emitted: void[] = [];
    fixture.componentInstance.downloadCancelRequested.subscribe(() => emitted.push(undefined));

    const panel = fixture.debugElement.query(By.directive(OnboardingPanelComponent))
      .componentInstance as OnboardingPanelComponent;
    panel.downloadCancelRequested.emit();

    expect(emitted.length).toBe(1);
  });
});
