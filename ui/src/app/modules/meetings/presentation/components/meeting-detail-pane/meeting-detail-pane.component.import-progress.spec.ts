import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { vi } from 'vitest';

import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { SummaryTemplate } from '../../../core/models/summary-template.model';
import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import { WelcomePanelComponent } from '../welcome-panel/welcome-panel.component';
import { MeetingDetailPaneComponent } from './meeting-detail-pane.component';
import { AudioPlayerComponent } from '../audio-player/audio-player.component';
import { MeetingsFacade } from '../../../application/facades/meetings.facade';

class MockMeetingsFacade {
  getAudioUrl = vi.fn().mockResolvedValue(null);
}

/**
 * Phase 5 presentation coverage: the determinate import/re-transcribe
 * progress bar in the detail-pane header, the two re-transcribe actions in
 * the actions row, and re-emitting the welcome panel's Import a recording
 * button. Split into its own file — the main spec is already near the
 * project's 400-line cap (same pattern as `meeting-detail-pane.component.welcome.spec.ts`).
 */
describe('MeetingDetailPaneComponent import/re-transcribe', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [MeetingDetailPaneComponent, AudioPlayerComponent],
      providers: [
        { provide: MeetingsFacade, useClass: MockMeetingsFacade },
      ],
    });
  });

  const templates: SummaryTemplate[] = [{ name: 'key-points', description: 'Key points', prompt: 'p' }];

  const meetingWithAudio: Meeting = {
    id: toMeetingId('m1'),
    title: 'Standup',
    createdAt: new Date(2026, 7, 27, 14, 2),
    durationSec: 32 * 60,
    transcript: { segments: [transcriptSegment({ startSec: 4, endSec: 6, text: 'On commence.' })] },
    summaries: [],
    archived: false,
    hasAudio: true,
    hasSystemTrack: true,
    droppedAudioChunks: 0,
  };

  const createFixture = (meeting: Meeting = meetingWithAudio) => {
    const fixture = TestBed.createComponent(MeetingDetailPaneComponent);
    fixture.componentRef.setInput('modelsReady', true);
    fixture.componentRef.setInput('recordingState', 'idle');
    fixture.componentRef.setInput('captureSource', 'microphone');
    fixture.componentRef.setInput('templates', templates);
    fixture.componentRef.setInput('selectedSummaryLanguage', 'en');
    fixture.componentRef.setInput('meeting', meeting);
    fixture.componentRef.setInput('hasAudio', meeting.hasAudio);
    fixture.detectChanges();
    return fixture;
  };

  it('disables "Re-transcribe from audio" when hasAudio is false', () => {
    const fixture = createFixture({ ...meetingWithAudio, hasAudio: false, hasSystemTrack: false, droppedAudioChunks: 0 });

    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.retranscribe');
    expect(button.disabled).toBe(true);
  });

  it('enables "Re-transcribe from audio" when hasAudio is true and nothing else is running', () => {
    const fixture = createFixture();

    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.retranscribe');
    expect(button.disabled).toBe(false);
  });

  it('emits retranscribeRequested when "Re-transcribe from audio" is clicked', () => {
    const fixture = createFixture();
    const emitted: number[] = [];
    fixture.componentInstance.retranscribeRequested.subscribe(() => emitted.push(1));

    fixture.nativeElement.querySelector('.retranscribe').click();

    expect(emitted).toEqual([1]);
  });

  it('keeps "Replace audio & re-transcribe…" enabled even when hasAudio is false', () => {
    const fixture = createFixture({ ...meetingWithAudio, hasAudio: false, hasSystemTrack: false, droppedAudioChunks: 0 });

    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.replace-audio');
    expect(button.disabled).toBe(false);
  });

  it('emits replaceAudioRequested when "Replace audio & re-transcribe…" is clicked', () => {
    const fixture = createFixture();
    const emitted: number[] = [];
    fixture.componentInstance.replaceAudioRequested.subscribe(() => emitted.push(1));

    fixture.nativeElement.querySelector('.replace-audio').click();

    expect(emitted).toEqual([1]);
  });

  it('disables both re-transcribe actions while a recording is in progress', () => {
    const fixture = TestBed.createComponent(MeetingDetailPaneComponent);
    fixture.componentRef.setInput('modelsReady', true);
    fixture.componentRef.setInput('recordingState', 'recording');
    fixture.componentRef.setInput('captureSource', 'microphone');
    fixture.componentRef.setInput('templates', templates);
    fixture.componentRef.setInput('selectedSummaryLanguage', 'en');
    fixture.componentRef.setInput('meeting', meetingWithAudio);
    fixture.componentRef.setInput('hasAudio', true);
    fixture.detectChanges();

    expect((fixture.nativeElement.querySelector('.retranscribe') as HTMLButtonElement).disabled).toBe(true);
    expect((fixture.nativeElement.querySelector('.replace-audio') as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables both re-transcribe actions while importing', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('importing', true);
    fixture.detectChanges();

    expect((fixture.nativeElement.querySelector('.retranscribe') as HTMLButtonElement).disabled).toBe(true);
    expect((fixture.nativeElement.querySelector('.replace-audio') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows no progress bar and no Cancel button when not importing', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('.import-progress')).toBeNull();
  });

  it('renders "Converting audio…" during the converting phase', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('importing', true);
    fixture.componentRef.setInput('importProgress', {
      meetingId: meetingWithAudio.id,
      phase: 'converting',
      processedSec: 0,
      totalSec: 0,
    });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.import-progress-label').textContent).toBe('Converting audio…');
  });

  it('renders the determinate mm:ss "Transcribing M:SS / M:SS" label during the transcribing phase', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('importing', true);
    fixture.componentRef.setInput('importProgress', {
      meetingId: meetingWithAudio.id,
      phase: 'transcribing',
      processedSec: 65,
      totalSec: 130,
    });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.import-progress-label').textContent).toBe(
      'Transcribing 01:05 / 02:10',
    );
    const fill: HTMLElement = fixture.nativeElement.querySelector('.import-progress-fill');
    expect(fill.style.width).toBe('50%');
  });

  it('hides the progress bar once the phase reaches done', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('importing', true);
    fixture.componentRef.setInput('importProgress', {
      meetingId: meetingWithAudio.id,
      phase: 'done',
      processedSec: 130,
      totalSec: 130,
    });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.import-progress')).toBeNull();
  });

  it('emits cancelImportRequested when the inline Cancel button is clicked', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('importing', true);
    fixture.componentRef.setInput('importProgress', {
      meetingId: meetingWithAudio.id,
      phase: 'transcribing',
      processedSec: 10,
      totalSec: 20,
    });
    fixture.detectChanges();
    const emitted: number[] = [];
    fixture.componentInstance.cancelImportRequested.subscribe(() => emitted.push(1));

    fixture.nativeElement.querySelector('.cancel-import').click();

    expect(emitted).toEqual([1]);
  });

  it('renders the live-transcript component (not the static transcript view) while importing', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('importing', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-live-transcript')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('app-transcript-view')).toBeNull();
  });

  it('re-emits importRequested from the welcome panel', () => {
    const fixture = TestBed.createComponent(MeetingDetailPaneComponent);
    fixture.componentRef.setInput('modelsReady', true);
    fixture.componentRef.setInput('recordingState', 'idle');
    fixture.componentRef.setInput('captureSource', 'microphone');
    fixture.componentRef.setInput('selectedSummaryLanguage', 'en');
    fixture.detectChanges();
    const emitted: number[] = [];
    fixture.componentInstance.importRequested.subscribe(() => emitted.push(1));

    const welcomePanel = fixture.debugElement.query(By.directive(WelcomePanelComponent))
      .componentInstance as WelcomePanelComponent;
    welcomePanel.importRequested.emit();

    expect(emitted).toEqual([1]);
  });

  it('renders the re-ingest controls above the transcript, not in the top actions row (narrow)', () => {
    const fixture = createFixture();

    const actionsRow: HTMLElement = fixture.nativeElement.querySelector('.actions-row');
    expect(actionsRow.querySelector('.reingest-controls')).toBeNull();

    const toolbar: HTMLElement = fixture.nativeElement.querySelector('.tab-content .pane-toolbar-transcript');
    expect(toolbar.querySelector('.retranscribe')).toBeTruthy();
    // The toolbar precedes the transcript body it sits above, as a direct
    // child of the narrow tab-content column.
    const tabContent: HTMLElement = fixture.nativeElement.querySelector('.tab-content');
    const order = Array.from(tabContent.children);
    const toolbarIndex = order.findIndex((child) => child.classList.contains('pane-toolbar-transcript'));
    const transcriptIndex = order.findIndex((child) => child.tagName === 'APP-TRANSCRIPT-VIEW');
    expect(toolbarIndex).toBeGreaterThanOrEqual(0);
    expect(transcriptIndex).toBeGreaterThan(toolbarIndex);
  });

  it('renders the summary-language picker above the summary, not in the top actions row (narrow)', () => {
    const fixture = createFixture();
    fixture.componentInstance.selectTab('key-points');
    fixture.detectChanges();

    const actionsRow: HTMLElement = fixture.nativeElement.querySelector('.actions-row');
    expect(actionsRow.querySelector('app-summary-language-picker')).toBeNull();

    const toolbar: HTMLElement = fixture.nativeElement.querySelector('.tab-content .pane-toolbar-summary');
    expect(toolbar.querySelector('app-summary-language-picker')).toBeTruthy();
  });
});
