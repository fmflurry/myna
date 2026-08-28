import { TestBed } from '@angular/core/testing';

import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { SummaryTemplate } from '../../../core/models/summary-template.model';
import { MeetingDetailPaneComponent } from './meeting-detail-pane.component';

/**
 * Regression coverage for the reported bug: "if I go in the meeting notes
 * tab, all the other tabs will show the exact same loader, which is wrong
 * because we are generating meeting notes, not decisions or action items."
 *
 * Root cause was a single global `summarizing` boolean driving every tab's
 * render. The fix threads a `summarizingKey` — the (template, language)
 * pair actually generating — through so only the matching tab shows the
 * loader, the streaming tokens, and Cancel; every other tab shows its own
 * real state and a Generate button disabled with a visible reason. Split
 * into its own file to keep `meeting-detail-pane.component.spec.ts` under
 * the project's max-lines limit.
 */
describe('MeetingDetailPaneComponent summarizingKey', () => {
  const templates: SummaryTemplate[] = [
    { name: 'meeting-notes', description: 'Meeting notes', prompt: 'p', label: 'Notes', emoji: '📝' },
    { name: 'decisions', description: 'Decisions', prompt: 'p', label: 'Decisions', emoji: '⚖️' },
  ];

  const meeting: Meeting = {
    id: toMeetingId('m1'),
    title: 'Standup',
    createdAt: new Date(2026, 7, 27, 14, 2),
    durationSec: 32 * 60,
    summaries: [],
    archived: false,
  };

  const findDecisionsTab = (fixture: ReturnType<typeof createFixture>): HTMLButtonElement | undefined => {
    const tabs: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.tab'));
    return tabs.find((tab) => tab.textContent?.includes('Decisions'));
  };

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

  it('REGRESSION: shows no loader and no streamed tokens on a different tab while another template generates', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('summarizing', true);
    fixture.componentRef.setInput('summarizingKey', { template: 'meeting-notes', language: 'en' });
    fixture.componentRef.setInput('summaryStream', 'partial meeting notes markdown');
    fixture.detectChanges();

    findDecisionsTab(fixture)?.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-summary-panel .status')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('partial meeting notes markdown');
    expect(fixture.nativeElement.querySelector('.generate')).toBeTruthy();
  });

  it('shows the loader, the streamed tokens, and Cancel on the tab that IS generating', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('summarizing', true);
    fixture.componentRef.setInput('summarizingKey', { template: 'meeting-notes', language: 'en' });
    fixture.componentRef.setInput('summaryStream', 'partial meeting notes markdown');
    fixture.detectChanges();

    fixture.componentInstance.selectTab('meeting-notes');
    fixture.detectChanges();

    const status = fixture.nativeElement.querySelector('app-summary-panel .status');
    expect(status).toBeTruthy();
    expect(fixture.nativeElement.querySelector('app-summary-panel .cancel')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('partial meeting notes markdown');
  });

  it('treats a different language for the same template as a different tab — no loader, no leaked tokens', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('summarizing', true);
    fixture.componentRef.setInput('summarizingKey', { template: 'meeting-notes', language: 'en' });
    fixture.componentRef.setInput('summaryStream', 'english draft');
    fixture.componentRef.setInput('selectedSummaryLanguage', 'fr');
    fixture.detectChanges();

    fixture.componentInstance.selectTab('meeting-notes');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-summary-panel .status')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('english draft');
    expect(fixture.nativeElement.querySelector('.generate')).toBeTruthy();
  });

  it('disables Generate on other tabs with a visible reason naming what is generating', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('summarizing', true);
    fixture.componentRef.setInput('summarizingKey', { template: 'meeting-notes', language: 'en' });
    fixture.detectChanges();

    findDecisionsTab(fixture)?.click();
    fixture.detectChanges();

    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.generate-button');
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('Notes');
    expect(fixture.nativeElement.querySelector('.generate .busy-hint')?.textContent).toContain('Notes');
  });

  it('a disabled Generate elsewhere never emits summarizeRequested, even if clicked', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('summarizing', true);
    fixture.componentRef.setInput('summarizingKey', { template: 'meeting-notes', language: 'en' });
    fixture.detectChanges();
    findDecisionsTab(fixture)?.click();
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.summarizeRequested.subscribe((name) => emitted.push(name));

    fixture.nativeElement.querySelector('.generate-button').click();

    expect(emitted).toEqual([]);
  });

  it('re-enables Generate on the other tab once summarizingKey clears', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('summarizing', true);
    fixture.componentRef.setInput('summarizingKey', { template: 'meeting-notes', language: 'en' });
    fixture.detectChanges();
    findDecisionsTab(fixture)?.click();
    fixture.detectChanges();
    expect((fixture.nativeElement.querySelector('.generate-button') as HTMLButtonElement).disabled).toBe(true);

    fixture.componentRef.setInput('summarizing', false);
    fixture.componentRef.setInput('summarizingKey', null);
    fixture.detectChanges();

    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.generate-button');
    expect(button.disabled).toBe(false);
    const emitted: string[] = [];
    fixture.componentInstance.summarizeRequested.subscribe((name) => emitted.push(name));
    button.click();
    expect(emitted).toEqual(['decisions']);
  });
});
