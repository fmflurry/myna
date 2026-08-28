import { TestBed } from '@angular/core/testing';

import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { SummaryTemplate } from '../../../core/models/summary-template.model';
import { formatTemplateLabel } from '../../utils/format-display.util';
import { MeetingDetailPaneComponent } from './meeting-detail-pane.component';

describe('MeetingDetailPaneComponent', () => {
  const templates: SummaryTemplate[] = [
    { name: 'key-points', description: 'Key points', prompt: 'p' },
  ];

  const meeting: Meeting = {
    id: toMeetingId('m1'),
    title: 'Standup',
    createdAt: new Date(2026, 7, 27, 14, 2),
    durationSec: 32 * 60,
    transcript: { segments: [{ startSec: 4, endSec: 6, text: 'On commence.' }] },
    summaries: [],
    archived: false,
    hasAudio: false,
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

  it('renders the onboarding panel instead of a route when models are not ready', () => {
    const fixture = TestBed.createComponent(MeetingDetailPaneComponent);
    fixture.componentRef.setInput('modelsReady', false);
    fixture.componentRef.setInput('recordingState', 'idle');
    fixture.componentRef.setInput('captureSource', 'microphone');
    fixture.componentRef.setInput('selectedSummaryLanguage', 'en');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-onboarding-panel')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.detail-heading')).toBeNull();
  });

  // The empty-pane prompt was replaced by <app-welcome-panel>; that
  // behavior is covered in meeting-detail-pane.component.welcome.spec.ts.

  it('renders the heading, meta line, and defaults to the Transcript tab', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('meeting', meeting);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('h1').textContent).toContain('Standup');
    expect(fixture.nativeElement.querySelector('h1').textContent).toContain('27 Aug, 14:02');
    expect(fixture.nativeElement.querySelector('.meta').textContent).toContain('32 min');
    expect(fixture.nativeElement.querySelector('app-transcript-view')).toBeTruthy();
  });

  it('emits renameRequested with the new title when the editable heading is committed', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('meeting', meeting);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.renameRequested.subscribe((title) => emitted.push(title));

    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('.title-trigger');
    trigger.click();
    fixture.detectChanges();

    const input: HTMLInputElement = fixture.nativeElement.querySelector('.title-input');
    input.value = 'Weekly standup';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    expect(emitted).toEqual(['Weekly standup']);
  });

  it('never renders a speaker count or a language in the meta line', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('meeting', meeting);
    fixture.detectChanges();

    const meta: string = fixture.nativeElement.querySelector('.meta').textContent;
    expect(meta).not.toMatch(/speaker/i);
    expect(meta).not.toMatch(/\bfr\b|\ben\b|\bde\b|\bes\b/i);
  });

  it('shows the live transcript, and the effective capture source, while recording', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('meeting', meeting);
    fixture.componentRef.setInput('recordingState', 'recording');
    fixture.componentRef.setInput('captureSource', 'system');
    fixture.componentRef.setInput('effectiveSystemSource', { id: 'system:all', name: 'All System Audio' });
    fixture.componentRef.setInput('finalizedSegments', [{ startSec: 0, endSec: 1, text: 'Hi' }]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-live-transcript')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('app-transcript-view')).toBeNull();
    expect(fixture.nativeElement.querySelector('.meta').textContent).toContain('System audio');
  });

  it('shows the EFFECTIVE source, not the requested one, when the recorder degraded to mic-only — never both at once', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('meeting', meeting);
    fixture.componentRef.setInput('recordingState', 'recording');
    fixture.componentRef.setInput('captureSource', 'mixed');
    // effectiveSystemSource left at its default (null): the tap silently
    // fell back to microphone only, mirroring what the title-bar's own
    // degraded-source hint ("Mic only") already reports.
    fixture.detectChanges();

    const meta: string = fixture.nativeElement.querySelector('.meta').textContent;
    expect(meta).toContain('Mic only');
    expect(meta).not.toContain('Mic + system');
  });

  it('switches to a template tab and offers to generate when no summary exists yet', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('meeting', meeting);
    fixture.detectChanges();

    const expectedLabel = formatTemplateLabel(templates[0]!);
    const tabs: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('.tab'));
    const keyPointsTab = tabs.find((tab) => tab.textContent?.trim() === expectedLabel);
    keyPointsTab?.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.generate')).toBeTruthy();
  });

  it('renders compact emoji tab labels, never the full-sentence description, and keeps the description as a tooltip', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('meeting', meeting);
    fixture.componentRef.setInput('templates', [
      { name: 'meeting-notes', description: 'A long sentence describing this template in full.', prompt: 'p', label: 'Notes', emoji: '📝' },
    ]);
    fixture.detectChanges();

    const tabs: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.tab'));
    const notesTab = tabs.find((tab) => tab.textContent?.includes('Notes'));

    expect(notesTab?.textContent?.trim()).toBe('📝 Notes');
    expect(notesTab?.textContent).not.toContain('A long sentence');
    expect(notesTab?.title).toBe('A long sentence describing this template in full.');
  });

  it('prefixes the transcript tab with a static emoji label', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('meeting', meeting);
    fixture.detectChanges();

    const tabs: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.tab'));
    const transcriptTab = tabs.find((tab) => tab.textContent?.includes('Transcript'));

    expect(transcriptTab?.textContent?.trim()).toBe('📄 Transcript');
  });

  it('emits summarizeRequested with the active tab name', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('meeting', meeting);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.summarizeRequested.subscribe((name) => emitted.push(name));

    fixture.componentInstance.selectTab('key-points');
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.generate button').click();

    expect(emitted).toEqual(['key-points']);
  });

  it('renders an existing summary for a tab instead of the generate prompt', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('meeting', {
      ...meeting,
      summaries: [{ template: 'key-points', markdown: '# Points', createdAt: new Date(), language: 'en' }],
    });
    fixture.detectChanges();

    fixture.componentInstance.selectTab('key-points');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-summary-panel')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.generate')).toBeNull();
  });

  it('shows the generate prompt, not a stale summary, when the tab has content in a different language', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('meeting', {
      ...meeting,
      summaries: [{ template: 'key-points', markdown: '# Points', createdAt: new Date(), language: 'fr' }],
    });
    fixture.detectChanges();

    fixture.componentInstance.selectTab('key-points');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.generate')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('app-summary-panel')).toBeNull();
  });

  it('lets an English and a French summary for the same template coexist without hiding either', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('meeting', {
      ...meeting,
      summaries: [
        { template: 'key-points', markdown: '# EN Points', createdAt: new Date(), language: 'en' },
        { template: 'key-points', markdown: '# FR Points', createdAt: new Date(), language: 'fr' },
      ],
    });
    fixture.componentRef.setInput('selectedSummaryLanguage', 'fr');
    fixture.detectChanges();

    fixture.componentInstance.selectTab('key-points');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-summary-panel pre').textContent).toBe('# FR Points');

    fixture.componentRef.setInput('selectedSummaryLanguage', 'en');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-summary-panel pre').textContent).toBe('# EN Points');
  });

  it('emits summaryLanguageSelected with the chosen language code', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('meeting', meeting);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.summaryLanguageSelected.subscribe((code) => emitted.push(code));

    fixture.componentInstance.onSummaryLanguageSelected('fr');

    expect(emitted).toEqual(['fr']);
  });

  it('emits exportRequested with the selected format', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('meeting', meeting);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.exportRequested.subscribe((format) => emitted.push(format));

    const select: HTMLSelectElement = fixture.nativeElement.querySelector('.actions-row .export-format');
    select.value = 'txt';
    select.dispatchEvent(new Event('change'));
    fixture.nativeElement.querySelector('.actions-row .export').click();

    expect(emitted).toEqual(['txt']);
  });

  it('shows an "Exporting…" busy state on the export button instead of a dead-looking control', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('meeting', meeting);
    fixture.componentRef.setInput('exporting', true);
    fixture.detectChanges();

    const exportButton: HTMLButtonElement = fixture.nativeElement.querySelector('.actions-row .export');
    expect(exportButton.textContent).toContain('Exporting');
    expect(exportButton.disabled).toBe(true);
    expect(exportButton.getAttribute('aria-busy')).toBe('true');
  });

  it('switching tabs still works while a summary is generating — reading the transcript is never blocked', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('meeting', meeting);
    fixture.componentRef.setInput('summarizing', true);
    fixture.componentRef.setInput('summarizingKey', { template: 'key-points', language: 'en' });
    fixture.detectChanges();

    fixture.componentInstance.selectTab('key-points');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-summary-panel')).toBeTruthy();

    fixture.componentInstance.selectTab('transcript');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-transcript-view')).toBeTruthy();
  });

  it('does not render the summary-language picker on the Transcript tab — Parakeet auto-detects, there is no choice to make', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('meeting', meeting);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-summary-language-picker')).toBeNull();
    expect(fixture.nativeElement.querySelector('.export-controls')).toBeTruthy();
  });

  it('renders the summary-language picker once a template tab is active', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('meeting', meeting);
    fixture.detectChanges();

    fixture.componentInstance.selectTab('key-points');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-summary-language-picker')).toBeTruthy();
  });

  it('falls back to "Untitled meeting" when the title is blank, instead of a leading dash', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('meeting', { ...meeting, title: '' });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.title-trigger').textContent.trim()).toBe('Untitled meeting');
  });

  describe('restart regression: a persisted-but-unfetched summary ref', () => {
    const refOnlyMeeting: Meeting = {
      ...meeting,
      summaries: [{ template: 'key-points', markdown: '', createdAt: new Date(), language: 'en' }],
    };

    it('requests a summary load when the active tab has a ref with no markdown and no cache entry yet', () => {
      const fixture = createFixture();
      fixture.componentRef.setInput('meeting', refOnlyMeeting);
      fixture.detectChanges();
      const requests: { meetingId: string; template: string; language: string }[] = [];
      fixture.componentInstance.summaryLoadRequested.subscribe((request) => requests.push(request));

      fixture.componentInstance.selectTab('key-points');
      fixture.detectChanges();

      expect(requests).toEqual([{ meetingId: 'm1', template: 'key-points', language: 'en' }]);
    });

    it('does not re-request once a cache entry already exists for that triple', () => {
      const fixture = createFixture();
      fixture.componentRef.setInput('meeting', refOnlyMeeting);
      fixture.componentRef.setInput('summaryCache', new Map([['m1::key-points::en', { status: 'loading' }]]));
      fixture.detectChanges();
      const requests: unknown[] = [];
      fixture.componentInstance.summaryLoadRequested.subscribe((request) => requests.push(request));

      fixture.componentInstance.selectTab('key-points');
      fixture.detectChanges();

      expect(requests).toEqual([]);
    });

    it('shows a distinct loading state, not the empty "Generate" prompt, while the fetch is in flight', () => {
      const fixture = createFixture();
      fixture.componentRef.setInput('meeting', refOnlyMeeting);
      fixture.componentRef.setInput('summaryCache', new Map([['m1::key-points::en', { status: 'loading' }]]));
      fixture.detectChanges();

      fixture.componentInstance.selectTab('key-points');
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('app-summary-panel')).toBeTruthy();
      expect(fixture.nativeElement.querySelector('.status.loading')).toBeTruthy();
      expect(fixture.nativeElement.querySelector('.generate')).toBeNull();
    });

    it('renders the summary once the cache resolves it as loaded', () => {
      const fixture = createFixture();
      fixture.componentRef.setInput('meeting', refOnlyMeeting);
      fixture.componentRef.setInput(
        'summaryCache',
        new Map([
          [
            'm1::key-points::en',
            {
              status: 'loaded',
              summary: { template: 'key-points', markdown: '# Restored', createdAt: new Date(), language: 'en' },
            },
          ],
        ]),
      );
      fixture.detectChanges();

      fixture.componentInstance.selectTab('key-points');
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('app-summary-panel pre').textContent).toBe('# Restored');
    });

    it('shows the empty "Generate" state only once the cache resolves to empty', () => {
      const fixture = createFixture();
      fixture.componentRef.setInput('meeting', refOnlyMeeting);
      fixture.componentRef.setInput('summaryCache', new Map([['m1::key-points::en', { status: 'empty' }]]));
      fixture.detectChanges();

      fixture.componentInstance.selectTab('key-points');
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.generate')).toBeTruthy();
      expect(fixture.nativeElement.querySelector('app-summary-panel')).toBeNull();
    });
  });
});
