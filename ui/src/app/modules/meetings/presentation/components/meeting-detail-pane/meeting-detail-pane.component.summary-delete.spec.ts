import { TestBed } from '@angular/core/testing';
import { afterEach, vi } from 'vitest';

import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { SummaryTemplate } from '../../../core/models/summary-template.model';
import type { SummaryDelete } from './meeting-detail-pane.component.support';
import { MeetingDetailPaneComponent } from './meeting-detail-pane.component';

/**
 * The toolbar Delete is confirm-guarded emit-only: hidden without an
 * existing summary, disabled by the same guard as Regenerate, a declined
 * confirmation emits nothing, and a confirmed one emits the (meeting,
 * template, language) triple and returns focus to Generate once that branch
 * mounts. Real DOM dispatch throughout — a dropped binding at either hop
 * fails here.
 */
describe('MeetingDetailPaneComponent — summary delete', () => {
  const templates: SummaryTemplate[] = [
    { name: 'key-points', description: 'Key points', prompt: 'p', label: 'Key Points', emoji: '🔑' },
    { name: 'action-items', description: 'Action items', prompt: 'p', label: 'Action Items', emoji: '✅' },
  ];

  const meetingWithSummary: Meeting = {
    id: toMeetingId('m1'),
    title: 'Standup',
    createdAt: new Date(2026, 7, 27, 14, 2),
    durationSec: 32 * 60,
    transcript: { segments: [{ startSec: 4, endSec: 6, text: 'On commence.', speaker: 'me' }] },
    summaries: [
      { template: 'key-points', markdown: '# Original', createdAt: new Date(), language: 'en', stale: false },
    ],
    archived: false,
    hasAudio: false,
    hasSystemTrack: false,
    droppedAudioChunks: 0,
  };

  const meetingWithoutSummary: Meeting = { ...meetingWithSummary, summaries: [] };

  const createFixture = (meeting: Meeting) => {
    const fixture = TestBed.createComponent(MeetingDetailPaneComponent);
    fixture.componentRef.setInput('modelsReady', true);
    fixture.componentRef.setInput('recordingState', 'idle');
    fixture.componentRef.setInput('captureSource', 'microphone');
    fixture.componentRef.setInput('templates', templates);
    fixture.componentRef.setInput('selectedSummaryLanguage', 'en');
    fixture.componentRef.setInput('meeting', meeting);
    fixture.detectChanges();
    fixture.componentInstance.selectTab('key-points');
    fixture.detectChanges();
    return fixture;
  };

  afterEach(() => vi.restoreAllMocks());

  it('hides Delete when there is no existing summary', () => {
    const fixture = createFixture(meetingWithoutSummary);

    expect(fixture.nativeElement.querySelector('.delete-summary')).toBeNull();
    expect(fixture.nativeElement.querySelector('.generate-button')).toBeTruthy();
  });

  it('disables Delete while regenerateDisabled and emits nothing on click', () => {
    const fixture = createFixture(meetingWithSummary);
    fixture.componentRef.setInput('summarizing', true);
    fixture.componentRef.setInput('summarizingKey', { template: 'key-points', language: 'en' });
    fixture.detectChanges();
    const emitted: SummaryDelete[] = [];
    fixture.componentInstance.summaryDeleted.subscribe((event) => emitted.push(event));
    const confirmSpy = vi.spyOn(window, 'confirm');
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.delete-summary');

    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.click();
    fixture.detectChanges();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it('emits nothing when the user declines the confirmation', () => {
    const fixture = createFixture(meetingWithSummary);
    const emitted: SummaryDelete[] = [];
    fixture.componentInstance.summaryDeleted.subscribe((event) => emitted.push(event));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    (fixture.nativeElement.querySelector('.delete-summary') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0]?.[0])).toContain('key-points');
    expect(String(confirmSpy.mock.calls[0]?.[0])).toContain('en');
    expect(emitted).toEqual([]);
  });

  it('emits summaryDeleted with meeting, template and language after confirm', () => {
    const fixture = createFixture(meetingWithSummary);
    const emitted: SummaryDelete[] = [];
    fixture.componentInstance.summaryDeleted.subscribe((event) => emitted.push(event));
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    (fixture.nativeElement.querySelector('.delete-summary') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(emitted).toEqual([{ meetingId: toMeetingId('m1'), template: 'key-points', language: 'en' }]);
  });

  it('focuses Generate after a confirmed delete once that branch mounts', async () => {
    const fixture = createFixture(meetingWithSummary);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    (fixture.nativeElement.querySelector('.delete-summary') as HTMLButtonElement).click();
    // Simulates the facade removing the summary: the has-summary branch
    // unmounts and the Generate branch mounts before the queued focus runs.
    fixture.componentRef.setInput('meeting', meetingWithoutSummary);
    fixture.detectChanges();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.generate-button')).toBeTruthy();
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('.generate-button'));
  });
});
