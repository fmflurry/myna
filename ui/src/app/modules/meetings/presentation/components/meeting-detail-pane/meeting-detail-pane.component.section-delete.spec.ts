import { TestBed } from '@angular/core/testing';
import { afterEach, vi } from 'vitest';

import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { TranscriptSectionDelete } from '../transcript-view/transcript-view.component';
import { MeetingDetailPaneComponent } from './meeting-detail-pane.component';

/**
 * The pane must forward the transcript view's `sectionDeleted` untouched and
 * surface the undo affordance fed by the shell-computed labels. Real DOM
 * dispatch throughout — a dropped binding at either hop fails here.
 */
describe('MeetingDetailPaneComponent — section delete + undo affordance', () => {
  const meeting: Meeting = {
    id: toMeetingId('m1'),
    title: 'Standup',
    createdAt: new Date(),
    durationSec: 60,
    transcript: {
      segments: [
        transcriptSegment({ startSec: 0, endSec: 5, text: 'intro', speaker: 'me' }),
        transcriptSegment({ startSec: 56, endSec: 58, text: 'Yeah,', speaker: 'others' }),
        transcriptSegment({ startSec: 58, endSec: 60, text: 'long.', speaker: 'others' }),
      ],
    },
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
    fixture.componentRef.setInput('meeting', meeting);
    fixture.detectChanges();
    return fixture;
  };

  afterEach(() => vi.restoreAllMocks());

  const openDeleteMenu = (fixture: ReturnType<typeof createFixture>): HTMLButtonElement => {
    const chips: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.speaker-chip'));
    chips[1]!.click();
    fixture.detectChanges();
    const option = Array.from(
      fixture.nativeElement.querySelectorAll('.speaker-menu [role="menuitem"]'),
    ).find((el) => (el as HTMLElement).textContent?.trim() === 'Delete section…');
    if (!option) {
      throw new Error('Menu item "Delete section…" not found');
    }
    return option as HTMLButtonElement;
  };

  it('re-emits sectionDeleted with the group indices when the menu delete is confirmed', () => {
    const emitted: TranscriptSectionDelete[] = [];
    const fixture = createFixture();
    fixture.componentInstance.sectionDeleted.subscribe((event) => emitted.push(event));
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    openDeleteMenu(fixture).click();
    fixture.detectChanges();

    expect(emitted).toEqual([{ indices: [1, 2] }]);
  });

  it('shows a transcript Undo button labelled by transcriptUndoLabel and emits undoTranscriptRequested on click', () => {
    const fixture = createFixture();
    const emitted: unknown[] = [];
    fixture.componentInstance.undoTranscriptRequested.subscribe(() => emitted.push(undefined));
    expect(fixture.nativeElement.querySelector('.undo-transcript')).toBeNull();

    fixture.componentRef.setInput('transcriptUndoLabel', 'Undo delete of 2 segments');
    fixture.detectChanges();
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.undo-transcript');
    expect(button).toBeTruthy();
    expect(button.getAttribute('title')).toBe('Undo delete of 2 segments');

    button.click();
    expect(emitted.length).toBe(1);
  });

  it('shows a speaker Undo button labelled by speakerUndoLabel and emits undoSpeakerRequested on click', () => {
    const fixture = createFixture();
    const emitted: unknown[] = [];
    fixture.componentInstance.undoSpeakerRequested.subscribe(() => emitted.push(undefined));
    expect(fixture.nativeElement.querySelector('.undo-speaker')).toBeNull();

    fixture.componentRef.setInput('speakerUndoLabel', 'Undo rename of Jean');
    fixture.detectChanges();
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.undo-speaker');
    expect(button).toBeTruthy();
    expect(button.getAttribute('title')).toBe('Undo rename of Jean');

    button.click();
    expect(emitted.length).toBe(1);
  });
});
