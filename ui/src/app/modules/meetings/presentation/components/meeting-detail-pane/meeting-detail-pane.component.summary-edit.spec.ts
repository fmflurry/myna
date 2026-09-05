import { TestBed } from '@angular/core/testing';

import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { SummaryTemplate } from '../../../core/models/summary-template.model';
import { MeetingDetailPaneComponent } from './meeting-detail-pane.component';

/**
 * The summary edit event is emit-only end to end: the panel owns the
 * textarea, the pane tags the edited markdown with the (meeting, template,
 * language) triple it was edited against, and persistence is wired further
 * up (facade lands in a later phase). Both layout paths that render
 * `#summaryContent` — the narrow tab layout and the wide split workspace —
 * must re-emit identically.
 */
describe('MeetingDetailPaneComponent — summary edit re-emit', () => {
  const templates: SummaryTemplate[] = [
    { name: 'key-points', description: 'Key points', prompt: 'p', label: 'Key Points', emoji: '🔑' },
    { name: 'action-items', description: 'Action items', prompt: 'p', label: 'Action Items', emoji: '✅' },
  ];

  const meeting: Meeting = {
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

  /** Matches this component's own narrow/wide breakpoint. */
  const WIDE_WIDTH_PX = 1400;
  const DEFAULT_JSDOM_WIDTH_PX = 1024;

  const setViewportWidth = (width: number): void => {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
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

  const editSummaryViaToolbar = (fixture: ReturnType<typeof createFixture>): void => {
    const editButton: HTMLButtonElement = fixture.nativeElement.querySelector(
      '.pane-toolbar-summary .edit-summary',
    );
    editButton.click();
    fixture.detectChanges();
    const panel = fixture.nativeElement.querySelector('app-summary-panel');
    const textarea: HTMLTextAreaElement = panel.querySelector('.summary-input');
    textarea.value = '# Edited';
    textarea.dispatchEvent(new Event('input'));
    panel.querySelector('.done').click();
    fixture.detectChanges();
  };

  it('re-emits the edited markdown tagged with meeting, template and language (narrow tab layout)', () => {
    const fixture = createFixture();
    fixture.componentInstance.selectTab('key-points');
    fixture.detectChanges();
    const edits: unknown[] = [];
    fixture.componentInstance.summaryEdited.subscribe((edit) => edits.push(edit));

    editSummaryViaToolbar(fixture);

    expect(edits).toEqual([
      { meetingId: 'm1', template: 'key-points', language: 'en', markdown: '# Edited' },
    ]);
  });

  it('groups Regenerate, Edit and Delete in the single summary toolbar row', () => {
    const fixture = createFixture();
    fixture.componentInstance.selectTab('key-points');
    fixture.detectChanges();

    const toolbar = fixture.nativeElement.querySelector('.pane-toolbar-summary');
    expect(toolbar.querySelector('.regenerate-button')).toBeTruthy();
    expect(toolbar.querySelector('.edit-summary')).toBeTruthy();
    expect(toolbar.querySelector('.delete-summary')).toBeTruthy();
  });

  it('re-emits identically through the wide split-workspace layout', () => {
    setViewportWidth(WIDE_WIDTH_PX);
    const fixture = createFixture();
    const edits: unknown[] = [];
    fixture.componentInstance.summaryEdited.subscribe((edit) => edits.push(edit));

    expect(fixture.nativeElement.querySelector('app-split-workspace')).toBeTruthy();
    editSummaryViaToolbar(fixture);

    expect(edits).toEqual([
      { meetingId: 'm1', template: 'key-points', language: 'en', markdown: '# Edited' },
    ]);
  });

  it('marks the panel non-editable while the active tab is generating', () => {
    const fixture = createFixture();
    fixture.componentInstance.selectTab('key-points');
    fixture.componentRef.setInput('summarizing', true);
    fixture.componentRef.setInput('summarizingKey', { template: 'key-points', language: 'en' });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.pane-toolbar-summary .edit-summary')).toBeNull();
  });
});
