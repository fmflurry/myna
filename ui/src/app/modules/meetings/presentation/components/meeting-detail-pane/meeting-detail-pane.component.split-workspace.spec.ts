import { TestBed } from '@angular/core/testing';

import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { SummaryTemplate } from '../../../core/models/summary-template.model';
import { SplitWorkspaceComponent } from '../split-workspace/split-workspace.component';
import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import { MeetingDetailPaneComponent } from './meeting-detail-pane.component';

/** Matches this component's own narrow/wide breakpoint. */
const WIDE_WIDTH_PX = 1400;
const NARROW_WIDTH_PX = 900;
const DEFAULT_JSDOM_WIDTH_PX = 1024;

const setViewportWidth = (width: number): void => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
};

describe('MeetingDetailPaneComponent — split-workspace layout', () => {
  const templates: SummaryTemplate[] = [
    { name: 'key-points', description: 'Key points', prompt: 'p', label: 'Key Points', emoji: '🔑' },
    { name: 'action-items', description: 'Action items', prompt: 'p', label: 'Action Items', emoji: '✅' },
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

  it('falls back to the narrow single-column tabbed layout below the breakpoint, Transcript tab included', () => {
    setViewportWidth(NARROW_WIDTH_PX);
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('app-split-workspace')).toBeNull();
    const tabs: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('.tab-row .tab'));
    expect(tabs.some((tab) => tab.textContent?.includes('Transcript'))).toBe(true);
  });

  it('renders the split workspace at and above the breakpoint, with no Transcript tab in the strip', () => {
    setViewportWidth(WIDE_WIDTH_PX);
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('app-split-workspace')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.tab-content')).toBeNull();
    const tabs: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('.tab-row .tab'));
    expect(tabs.some((tab) => tab.textContent?.includes('Transcript'))).toBe(false);
    expect(tabs.length).toBe(templates.length);
  });

  it('keeps the transcript visible in the left column of the wide layout regardless of which summary tab is active', () => {
    setViewportWidth(WIDE_WIDTH_PX);
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('app-transcript-view')).toBeTruthy();

    fixture.componentInstance.selectTab('action-items');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-transcript-view')).toBeTruthy();
  });

  it('defaults the right column to the first template before any tab is explicitly clicked', () => {
    setViewportWidth(WIDE_WIDTH_PX);
    const fixture = createFixture();
    fixture.componentRef.setInput('meeting', {
      ...meeting,
      summaries: [{ template: 'key-points', markdown: '# Points', createdAt: new Date(), language: 'en' }],
    });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-summary-panel pre')?.textContent).toBe('# Points');
    const tabs: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('.tab-row .tab'));
    expect(tabs.find((tab) => tab.textContent?.includes('Key Points'))?.classList.contains('active')).toBe(true);
  });

  it('passes the persisted split ratio and collapsed flag through to the split workspace', () => {
    setViewportWidth(WIDE_WIDTH_PX);
    const fixture = createFixture();
    fixture.componentRef.setInput('splitRatio', 0.6);
    fixture.componentRef.setInput('transcriptCollapsed', true);
    fixture.detectChanges();

    const split = fixture.debugElement.query(
      (node) => node.componentInstance instanceof SplitWorkspaceComponent,
    ).componentInstance as SplitWorkspaceComponent;

    expect(split.splitRatio()).toBe(0.6);
    expect(split.collapsed()).toBe(true);
  });

  it('forwards splitRatioChanged and collapsedChanged from the split workspace as its own outputs', () => {
    setViewportWidth(WIDE_WIDTH_PX);
    const fixture = createFixture();
    const ratios: number[] = [];
    const collapses: boolean[] = [];
    fixture.componentInstance.splitRatioChanged.subscribe((ratio) => ratios.push(ratio));
    fixture.componentInstance.transcriptCollapsedChanged.subscribe((collapsed) => collapses.push(collapsed));

    const split = fixture.debugElement.query(
      (node) => node.componentInstance instanceof SplitWorkspaceComponent,
    ).componentInstance as SplitWorkspaceComponent;
    split.splitRatioChanged.emit(0.5);
    split.collapsedChanged.emit(true);

    expect(ratios).toEqual([0.5]);
    expect(collapses).toEqual([true]);
  });
});
