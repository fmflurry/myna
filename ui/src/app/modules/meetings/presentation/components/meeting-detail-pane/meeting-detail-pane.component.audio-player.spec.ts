import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import { MeetingDetailPaneComponent } from './meeting-detail-pane.component';
import { AudioPlayerComponent } from '../audio-player/audio-player.component';
import { MeetingsFacade } from '../../../application/facades/meetings.facade';

class MockMeetingsFacade {
  getAudioUrl = vi.fn().mockResolvedValue(null);
}

describe('MeetingDetailPaneComponent audio player integration', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [MeetingDetailPaneComponent, AudioPlayerComponent],
      providers: [
        { provide: MeetingsFacade, useClass: MockMeetingsFacade },
      ],
    });
  });

  const meeting: Meeting = {
    id: toMeetingId('m1'),
    title: 'Standup',
    createdAt: new Date(2026, 7, 27, 14, 2),
    durationSec: 32 * 60,
    transcript: { segments: [transcriptSegment({ startSec: 4, endSec: 6, text: 'On commence.' })] },
    summaries: [],
    archived: false,
    hasAudio: false,
    hasSystemTrack: false,
    droppedAudioChunks: 0,
  };

  const createFixture = () => {
    const fixture = TestBed.createComponent(MeetingDetailPaneComponent);
    fixture.componentRef.setInput('modelsReady', true);
    fixture.componentRef.setInput('recordingState', 'idle');
    fixture.componentRef.setInput('captureSource', 'microphone');
    fixture.componentRef.setInput('selectedSummaryLanguage', 'en');
    fixture.detectChanges();
    return fixture;
  };

  it('should render audio player when meeting has audio', async () => {
    const facade = TestBed.inject(MeetingsFacade) as unknown as MockMeetingsFacade;
    facade.getAudioUrl = vi.fn().mockResolvedValue('tauri://audio.wav');

    const fixture = createFixture();
    const meetingWithAudio: Meeting = {
      ...meeting,
      hasAudio: true,
    };
    fixture.componentRef.setInput('meeting', meetingWithAudio);
    fixture.componentRef.setInput('hasAudio', true);
    fixture.detectChanges();

    await Promise.resolve();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-audio-player')).toBeTruthy();
  });

  it('should not render audio player when meeting has no audio', () => {
    const fixture = createFixture();
    const meetingWithoutAudio: Meeting = {
      ...meeting,
      hasAudio: false,
    };
    fixture.componentRef.setInput('meeting', meetingWithoutAudio);
    fixture.componentRef.setInput('hasAudio', false);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-audio-player')).toBeNull();
  });
});
