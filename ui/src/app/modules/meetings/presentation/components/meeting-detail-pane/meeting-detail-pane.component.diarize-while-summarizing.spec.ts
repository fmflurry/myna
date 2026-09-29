import { TestBed } from '@angular/core/testing';

import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { ModelsStatus } from '../../../core/models/models-status.model';
import type { SummaryTemplate } from '../../../core/models/summary-template.model';
import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import { MeetingDetailPaneComponent } from './meeting-detail-pane.component';

describe('MeetingDetailPaneComponent "Detect speakers" while a summary is generating', () => {
  const templates: SummaryTemplate[] = [
    { name: 'key-points', description: 'Key points', prompt: 'p' },
  ];

  const meeting: Meeting = {
    id: toMeetingId('m1'),
    title: 'Standup',
    createdAt: new Date(2026, 7, 27, 14, 2),
    durationSec: 32 * 60,
    transcript: { segments: [transcriptSegment({ startSec: 4, endSec: 6, text: 'On commence.' })] },
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
    fixture.detectChanges();
    return fixture;
  };

  const diarizationReadyStatus: ModelsStatus = {
    parakeet: { present: true, expectedFiles: [] },
    qwen: { present: true, expectedFiles: [] },
    silero: { present: true, expectedFiles: [] },
    diarization: { present: true, expectedFiles: [] },
    allPresent: true,
  };

  const createDiarizeReadyFixture = () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('meeting', { ...meeting, hasSystemTrack: true });
    fixture.componentRef.setInput('modelsStatus', diarizationReadyStatus);
    fixture.componentRef.setInput('hasSystemTrack', true);
    fixture.detectChanges();
    return fixture;
  };

  it('is enabled with no summarizingKey (control: every other durable reason is satisfied)', () => {
    const fixture = createDiarizeReadyFixture();

    const diarizeButton: HTMLButtonElement = fixture.nativeElement.querySelector('.detect-speakers');
    expect(diarizeButton.disabled).toBe(false);
  });

  it('disables "Detect speakers" while summarizingKey is non-null, with a reason mentioning the summary', () => {
    const fixture = createDiarizeReadyFixture();
    fixture.componentRef.setInput('summarizingKey', { template: 'key-points', language: 'en' });
    fixture.detectChanges();

    const diarizeButton: HTMLButtonElement = fixture.nativeElement.querySelector('.detect-speakers');
    expect(diarizeButton.disabled).toBe(true);
    expect(diarizeButton.getAttribute('title')).toMatch(/summary/i);
  });

  it('re-enables "Detect speakers" once summarizingKey clears back to null', () => {
    const fixture = createDiarizeReadyFixture();
    fixture.componentRef.setInput('summarizingKey', { template: 'key-points', language: 'en' });
    fixture.detectChanges();

    fixture.componentRef.setInput('summarizingKey', null);
    fixture.detectChanges();

    const diarizeButton: HTMLButtonElement = fixture.nativeElement.querySelector('.detect-speakers');
    expect(diarizeButton.disabled).toBe(false);
  });
});
