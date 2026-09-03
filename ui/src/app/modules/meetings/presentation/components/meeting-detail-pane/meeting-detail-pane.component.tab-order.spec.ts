import { TestBed } from '@angular/core/testing';

import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { SummaryTemplate } from '../../../core/models/summary-template.model';
import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import { setViewportWidth } from '../../../application/testing/viewport.helper';
import { MeetingDetailPaneComponent } from './meeting-detail-pane.component';

/** Matches this component's own narrow/wide breakpoint. */
const WIDE_WIDTH_PX = 1400;
const DEFAULT_JSDOM_WIDTH_PX = 1024;

describe('MeetingDetailPaneComponent — summary tab order', () => {
  // The backend lists templates alphabetically by name; these fixtures
  // reproduce exactly that incoming order.
  const builtInsAlphabetical: SummaryTemplate[] = [
    { name: 'action-items', description: 'Action items', prompt: 'p', label: 'Action Items', emoji: '✅' },
    { name: 'decisions', description: 'Decisions', prompt: 'p', label: 'Decisions', emoji: '⚖️' },
    { name: 'key-points', description: 'Key points', prompt: 'p', label: 'Key Points', emoji: '🔑' },
    { name: 'meeting-notes', description: 'Meeting notes', prompt: 'p', label: 'Notes', emoji: '📝' },
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

  const createFixture = (templates: readonly SummaryTemplate[]) => {
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

  afterEach(() => {
    setViewportWidth(DEFAULT_JSDOM_WIDTH_PX);
  });

  const tabNames = (fixture: ReturnType<typeof createFixture>): string[] => {
    const tabs: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('.tab-row .tab'));
    return tabs.map((tab) => tab.textContent?.trim() ?? '');
  };

  it('renders the built-in tabs as Notes, Key Points, Decisions, Action Items despite alphabetical input', () => {
    const fixture = createFixture(builtInsAlphabetical);

    // Narrow layout prepends the Transcript tab; the template tabs follow in display order.
    expect(tabNames(fixture)).toEqual(['📄 Transcript', '📝 Notes', '🔑 Key Points', '⚖️ Decisions', '✅ Action Items']);
  });

  it('keeps custom templates after the built-ins in their incoming relative order', () => {
    const fixture = createFixture([
      { name: 'weekly-recap', description: 'Recap', prompt: 'p' },
      ...builtInsAlphabetical,
      { name: 'follow-ups', description: 'Follow-ups', prompt: 'p' },
    ]);

    expect(tabNames(fixture).slice(1)).toEqual([
      '📝 Notes',
      '🔑 Key Points',
      '⚖️ Decisions',
      '✅ Action Items',
      '🗒️ Weekly Recap',
      '🗒️ Follow Ups',
    ]);
  });

  it('selects tabs by template name, so the reordered Notes tab drives the summary column', () => {
    const fixture = createFixture(builtInsAlphabetical);

    const notesTab: HTMLButtonElement = fixture.nativeElement.querySelectorAll('.tab-row .tab')[1];
    notesTab.click();
    fixture.detectChanges();

    expect(notesTab.classList.contains('active')).toBe(true);
    expect(fixture.nativeElement.querySelector('.generate')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.headline')?.textContent).toContain('Notes');
  });

  it('defaults the wide layout summary column to the first displayed tab (Notes)', () => {
    setViewportWidth(WIDE_WIDTH_PX);
    const fixture = createFixture(builtInsAlphabetical);
    fixture.componentRef.setInput('meeting', {
      ...meeting,
      summaries: [{ template: 'meeting-notes', markdown: '# Notes', createdAt: new Date(), language: 'en' }],
    });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-summary-panel pre')?.textContent).toBe('# Notes');
    const tabs: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('.tab-row .tab'));
    expect(tabs.find((tab) => tab.textContent?.includes('Notes'))?.classList.contains('active')).toBe(true);
  });
});
