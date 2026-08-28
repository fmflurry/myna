import { TestBed } from '@angular/core/testing';

import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { SummaryTemplate } from '../../../core/models/summary-template.model';
import type { TranscriptSegmentEdit } from '../transcript-view/transcript-view.component';
import { TranscriptViewComponent } from '../transcript-view/transcript-view.component';
import { MeetingDetailPaneComponent } from './meeting-detail-pane.component';

/** Matches this component's own narrow/wide breakpoint. */
const WIDE_WIDTH_PX = 1400;
const DEFAULT_JSDOM_WIDTH_PX = 1024;

const setViewportWidth = (width: number): void => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
};

describe('MeetingDetailPaneComponent — transcript segment editing', () => {
  const templates: SummaryTemplate[] = [{ name: 'key-points', description: 'Key points', prompt: 'p' }];

  const meeting: Meeting = {
    id: toMeetingId('m1'),
    title: 'Standup',
    createdAt: new Date(2026, 7, 27, 14, 2),
    durationSec: 32 * 60,
    transcript: { segments: [{ startSec: 4, endSec: 6, text: 'On commence.' }] },
    summaries: [],
    archived: false,
  };

  afterEach(() => {
    setViewportWidth(DEFAULT_JSDOM_WIDTH_PX);
  });

  const createFixture = () => {
    const fixture = TestBed.createComponent(MeetingDetailPaneComponent);
    fixture.componentRef.setInput('modelsReady', true);
    fixture.componentRef.setInput('recordingState', 'idle');
    fixture.componentRef.setInput('captureSource', 'microphone');
    fixture.componentRef.setInput('templates', templates);
    fixture.componentRef.setInput('selectedSummaryLanguage', 'en');
    fixture.componentRef.setInput('meeting', meeting);
    fixture.detectChanges();
    return fixture;
  };

  it('renders the live transcript, never the editable transcript view, while a recording is in progress', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('recordingState', 'recording');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-live-transcript')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('app-transcript-view')).toBeNull();
  });

  it('re-emits segmentEdited from the transcript view in the narrow layout', () => {
    const fixture = createFixture();
    const emitted: TranscriptSegmentEdit[] = [];
    fixture.componentInstance.segmentEdited.subscribe((edit) => emitted.push(edit));

    const transcriptView = fixture.debugElement.query(
      (node) => node.componentInstance instanceof TranscriptViewComponent,
    ).componentInstance as TranscriptViewComponent;
    transcriptView.segmentEdited.emit({ index: 0, text: 'On commence maintenant.' });

    expect(emitted).toEqual([{ index: 0, text: 'On commence maintenant.' }]);
  });

  it('re-emits segmentEdited from the transcript view in the wide layout too', () => {
    setViewportWidth(WIDE_WIDTH_PX);
    const fixture = createFixture();
    const emitted: TranscriptSegmentEdit[] = [];
    fixture.componentInstance.segmentEdited.subscribe((edit) => emitted.push(edit));

    const transcriptView = fixture.debugElement.query(
      (node) => node.componentInstance instanceof TranscriptViewComponent,
    ).componentInstance as TranscriptViewComponent;
    transcriptView.segmentEdited.emit({ index: 0, text: 'On commence maintenant.' });

    expect(emitted).toEqual([{ index: 0, text: 'On commence maintenant.' }]);
  });
});
