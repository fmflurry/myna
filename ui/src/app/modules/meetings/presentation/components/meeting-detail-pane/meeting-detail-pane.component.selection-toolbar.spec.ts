import { TestBed } from '@angular/core/testing';
import { afterEach } from 'vitest';

import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { TranscriptSelectionSpeakerAssignment } from '../transcript-view/transcript-view.component';
import { MeetingDetailPaneComponent } from './meeting-detail-pane.component';

/**
 * The pane must forward the selection toolbar's `selectionSpeakerAssigned`
 * untouched — a dropped binding at this hop strands the emit between the
 * transcript view and the shell's facade call. Real DOM selection and a full
 * `mousedown → mouseup → click` sequence throughout (Chrome suppresses clicks
 * on nodes detached mid-sequence; a bare `.click()` would hide that).
 */
describe('MeetingDetailPaneComponent — selection toolbar re-emit', () => {
  const meeting: Meeting = {
    id: toMeetingId('m1'),
    title: 'Standup',
    createdAt: new Date(),
    durationSec: 60,
    transcript: {
      segments: [
        transcriptSegment({ startSec: 0, endSec: 5, text: 'first line', speaker: 'me' }),
        transcriptSegment({ startSec: 5, endSec: 10, text: 'second line', speaker: 'others' }),
        transcriptSegment({ startSec: 10, endSec: 15, text: 'third line', speaker: 'others:2' }),
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
    document.body.appendChild(fixture.nativeElement);
    return fixture;
  };

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  const fullClick = (el: HTMLElement): void => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  };

  it('re-emits selectionSpeakerAssigned with every selected index when the toolbar picker is clicked', () => {
    const emitted: TranscriptSelectionSpeakerAssignment[] = [];
    const fixture = createFixture();
    fixture.componentInstance.selectionSpeakerAssigned.subscribe((event) => emitted.push(event));

    const hosts = Array.from(fixture.nativeElement.querySelectorAll('[data-segment-index]')) as HTMLElement[];
    expect(hosts.length).toBe(3);
    const range = document.createRange();
    const startText = document.createTreeWalker(hosts[0]!, NodeFilter.SHOW_TEXT).nextNode() as Text;
    const endText = document.createTreeWalker(hosts[2]!, NodeFilter.SHOW_TEXT).nextNode() as Text;
    range.setStart(startText, 0);
    range.setEnd(endText, endText.data.length);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    fixture.detectChanges();

    fullClick(fixture.nativeElement.querySelector('.selection-trigger'));
    fixture.detectChanges();
    const meItem = (
      Array.from(fixture.nativeElement.querySelectorAll('.selection-menu .speaker-menu [role="menuitem"]')) as HTMLButtonElement[]
    ).find((el) => el.textContent?.trim() === 'Me');
    expect(meItem).toBeDefined();
    fullClick(meItem!);

    expect(emitted).toEqual([{ indices: [0, 1, 2], speaker: 'me' }]);
    fixture.nativeElement.remove();
  });
});
