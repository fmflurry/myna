import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { SummaryTemplate } from '../../../core/models/summary-template.model';
import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import { MeetingDetailPaneComponent } from './meeting-detail-pane.component';
import { AudioPlayerComponent } from '../audio-player/audio-player.component';
import { MeetingsFacade } from '../../../application/facades/meetings.facade';

class MockMeetingsFacade {
  getAudioUrl = vi.fn().mockResolvedValue(null);
}

/**
 * Degraded-recording affordance: when a meeting's audio was silently dropped
 * during capture (`droppedAudioChunks > 0`), the transcript is incomplete
 * while the audio file itself is intact. Split into its own file to keep
 * `meeting-detail-pane.component.spec.ts` under the project's max-lines
 * limit (same pattern as the other `meeting-detail-pane.component.*.spec.ts`
 * files).
 */
describe('MeetingDetailPaneComponent degraded-recording affordance', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [MeetingDetailPaneComponent, AudioPlayerComponent],
      providers: [
        { provide: MeetingsFacade, useClass: MockMeetingsFacade },
      ],
    });
  });

  const templates: SummaryTemplate[] = [{ name: 'key-points', description: 'Key points', prompt: 'p' }];

  const meeting: Meeting = {
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

  const createFixture = (meetingOverride: Meeting = meeting) => {
    const fixture = TestBed.createComponent(MeetingDetailPaneComponent);
    fixture.componentRef.setInput('modelsReady', true);
    fixture.componentRef.setInput('recordingState', 'idle');
    fixture.componentRef.setInput('captureSource', 'microphone');
    fixture.componentRef.setInput('templates', templates);
    fixture.componentRef.setInput('selectedSummaryLanguage', 'en');
    fixture.componentRef.setInput('meeting', meetingOverride);
    fixture.componentRef.setInput('hasAudio', meetingOverride.hasAudio);
    fixture.detectChanges();
    return fixture;
  };

  it('shows a warning near the transcript and offers to re-transcribe when audio was silently dropped', () => {
    const fixture = createFixture({ ...meeting, droppedAudioChunks: 3 });

    const warning = fixture.nativeElement.querySelector('.degraded-audio-warning');
    expect(warning).toBeTruthy();
    expect(warning.textContent).toContain("Some audio wasn't transcribed");
    expect(warning.textContent).toContain('The recording is intact');
  });

  it('does not show the warning when no audio was dropped', () => {
    const fixture = createFixture({ ...meeting, droppedAudioChunks: 0 });

    expect(fixture.nativeElement.querySelector('.degraded-audio-warning')).toBeNull();
  });

  it("emits retranscribeRequested — the SAME output the existing re-transcribe button uses — from the warning's button", () => {
    const fixture = createFixture({ ...meeting, droppedAudioChunks: 2 });
    const emitted: void[] = [];
    fixture.componentInstance.retranscribeRequested.subscribe(() => emitted.push(undefined));

    fixture.nativeElement.querySelector('.degraded-audio-warning .recover-transcript').click();

    expect(emitted.length).toBe(1);
  });
});
