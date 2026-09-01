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
 * Loading state for speaker detection on a SAVED meeting. `diarizeMeeting`
 * shares the `importing` slot with re-transcribe, and the pane used to read
 * `showLiveTranscript = isLive() || importing()` — so a diarize run dropped
 * the transcript for the empty live-recording view. A diarize-only run must
 * instead show a "Detecting speakers…" status placeholder in place of the
 * transcript, and the transcript must return the moment it finishes.
 *
 * Split into its own file (same pattern as
 * `meeting-detail-pane.component.degraded-audio.spec.ts`) to stay under the
 * project's max-lines limit.
 */
describe('MeetingDetailPaneComponent diarize loading state', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [MeetingDetailPaneComponent, AudioPlayerComponent],
      providers: [{ provide: MeetingsFacade, useClass: MockMeetingsFacade }],
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
    hasAudio: false,
    hasSystemTrack: true,
    droppedAudioChunks: 0,
  };

  const createFixture = (diarizing: boolean, importing: boolean) => {
    const fixture = TestBed.createComponent(MeetingDetailPaneComponent);
    fixture.componentRef.setInput('modelsReady', true);
    fixture.componentRef.setInput('recordingState', 'idle');
    fixture.componentRef.setInput('captureSource', 'mixed');
    fixture.componentRef.setInput('templates', templates);
    fixture.componentRef.setInput('selectedSummaryLanguage', 'en');
    fixture.componentRef.setInput('meeting', meeting);
    fixture.componentRef.setInput('importing', importing);
    fixture.componentRef.setInput('diarizing', diarizing);
    fixture.detectChanges();
    return fixture;
  };

  it('shows a Detecting speakers… status placeholder instead of the empty live view while a saved meeting is diarized', () => {
    const fixture = createFixture(true, true);

    const placeholder = fixture.nativeElement.querySelector('.diarize-loading');
    expect(placeholder).toBeTruthy();
    expect(placeholder.getAttribute('role')).toBe('status');
    expect(placeholder.textContent).toContain('Detecting speakers');
    expect(fixture.nativeElement.querySelector('app-transcript-view')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-live-transcript')).toBeNull();
  });

  it('renders the transcript view again once diarization is done', () => {
    const fixture = createFixture(false, false);

    expect(fixture.nativeElement.querySelector('.diarize-loading')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-transcript-view')).toBeTruthy();
  });

  it('keeps the live transcript for a plain re-transcribe (importing without diarizing)', () => {
    const fixture = createFixture(false, true);

    expect(fixture.nativeElement.querySelector('app-live-transcript')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.diarize-loading')).toBeNull();
  });
});
