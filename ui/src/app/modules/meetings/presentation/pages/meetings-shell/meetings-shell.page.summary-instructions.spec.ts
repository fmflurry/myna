import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, type ParamMap } from '@angular/router';
import { By } from '@angular/platform-browser';
import { BehaviorSubject } from 'rxjs';
import { vi } from 'vitest';

import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import { MeetingsStore } from '../../../application/stores/meetings.store';
import { InMemoryAppInfoFake } from '../../../application/testing/in-memory-app-info.fake';
import { InMemoryAudioImportFake } from '../../../application/testing/in-memory-audio-import.fake';
import { InMemoryFileDialogFake } from '../../../application/testing/in-memory-file-dialog.fake';
import { InMemoryMeetingRepositoryFake } from '../../../application/testing/in-memory-meeting-repository.fake';
import { InMemoryMenuFake } from '../../../application/testing/in-memory-menu.fake';
import { InMemoryModelsStatusFake } from '../../../application/testing/in-memory-models-status.fake';
import { InMemoryPreferencesFake } from '../../../application/testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../../../application/testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../../../application/testing/in-memory-summarizer.fake';
import { InMemoryTemplateRepositoryFake } from '../../../application/testing/in-memory-template-repository.fake';
import { InMemoryTranscriberFake } from '../../../application/testing/in-memory-transcriber.fake';
import { InMemoryUpdatesFake } from '../../../application/testing/in-memory-updates.fake';
import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../../core/ports/meeting-repository.port';
import { AppInfoPort } from '../../../core/ports/app-info.port';
import { AudioImportPort } from '../../../core/ports/audio-import.port';
import { FileDialogPort } from '../../../core/ports/file-dialog.port';
import { MenuPort } from '../../../core/ports/menu.port';
import { ModelsStatusPort } from '../../../core/ports/models-status.port';
import { PreferencesPort } from '../../../core/ports/preferences.port';
import { RecorderPort } from '../../../core/ports/recorder.port';
import { SummarizerPort } from '../../../core/ports/summarizer.port';
import { TemplateRepositoryPort } from '../../../core/ports/template-repository.port';
import { TranscriberPort } from '../../../core/ports/transcriber.port';
import { UpdatesPort } from '../../../core/ports/updates.port';
import { flushMicrotasks } from '../../../infrastructure/tauri/testing/tauri-internals.stub';
import { provideMeetings } from '../../../meetings.providers';
import { MeetingDetailPaneComponent } from '../../components/meeting-detail-pane/meeting-detail-pane.component';
import { MeetingsShellPage } from './meetings-shell.page';

/**
 * Shell wiring for user-authored summary instructions at the real
 * facade/store boundary (same `provideMeetings()` + in-memory-port pattern
 * as `meetings-shell.page.settings.spec.ts`): guidelines load once on boot,
 * the Settings textarea round-trips through `facade.setSummaryGuidelines`,
 * and a draft emitted by the pane is persisted against the SELECTED meeting
 * and re-derived back down through the drafts map.
 */
describe('MeetingsShellPage summary instructions', () => {
  let menu: InMemoryMenuFake;
  let repository: InMemoryMeetingRepositoryFake;
  let routeParamMap: BehaviorSubject<ParamMap>;

  const meeting: Meeting = {
    id: toMeetingId('m1'),
    title: 'Standup',
    createdAt: new Date(2026, 7, 27, 14, 2),
    durationSec: 32 * 60,
    transcript: { segments: [] },
    summaries: [],
    archived: false,
    hasAudio: false, hasSystemTrack: false,
    droppedAudioChunks: 0,
  };

  beforeEach(() => {
    routeParamMap = new BehaviorSubject<ParamMap>(convertToParamMap({}));

    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { paramMap: routeParamMap } },
        provideMeetings(),
        { provide: MeetingRepositoryPort, useClass: InMemoryMeetingRepositoryFake },
        { provide: RecorderPort, useClass: InMemoryRecorderFake },
        { provide: SummarizerPort, useClass: InMemorySummarizerFake },
        { provide: TranscriberPort, useClass: InMemoryTranscriberFake },
        { provide: TemplateRepositoryPort, useClass: InMemoryTemplateRepositoryFake },
        { provide: ModelsStatusPort, useClass: InMemoryModelsStatusFake },
        { provide: FileDialogPort, useClass: InMemoryFileDialogFake },
        { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
        { provide: AppInfoPort, useClass: InMemoryAppInfoFake },
        { provide: AudioImportPort, useClass: InMemoryAudioImportFake },
        { provide: UpdatesPort, useClass: InMemoryUpdatesFake },
        { provide: MenuPort, useClass: InMemoryMenuFake },
      ],
    });

    menu = TestBed.inject(MenuPort) as InMemoryMenuFake;
    repository = TestBed.inject(MeetingRepositoryPort) as InMemoryMeetingRepositoryFake;
    (TestBed.inject(UpdatesPort) as InMemoryUpdatesFake).seedConsent('granted');
  });

  const createFixture = async () => {
    const fixture = TestBed.createComponent(MeetingsShellPage);
    fixture.detectChanges();
    await flushMicrotasks();
    fixture.detectChanges();
    return fixture;
  };

  it('loads the general guidelines once on boot', async () => {
    const facade = TestBed.inject(MeetingsFacade);
    const load = vi.spyOn(facade, 'loadSummaryGuidelines');

    await createFixture();

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('seeds the settings textarea from the store and persists the edited value trimmed', async () => {
    const facade = TestBed.inject(MeetingsFacade);
    const summarizer = TestBed.inject(SummarizerPort) as InMemorySummarizerFake;
    await summarizer.setGuidelines('Use bullet points.');
    const set = vi.spyOn(facade, 'setSummaryGuidelines');

    const fixture = await createFixture();
    menu.requestSettings();
    fixture.detectChanges();

    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('app-settings .guidelines-input');
    expect(textarea.value).toBe('Use bullet points.');

    textarea.value = '  Focus on risks.  ';
    textarea.dispatchEvent(new Event('input'));
    textarea.dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    expect(set).toHaveBeenCalledWith('Focus on risks.');
    await flushMicrotasks();
    fixture.detectChanges();
    expect(facade.summaryGuidelines()).toBe('Focus on risks.');
    expect((fixture.nativeElement.querySelector('app-settings .save-guidelines') as HTMLButtonElement).disabled).toBe(true);
  });

  it('persists a pane-emitted draft against the selected meeting and feeds it back down', async () => {
    repository.seed([meeting]);
    routeParamMap.next(convertToParamMap({ id: 'm1' }));
    const facade = TestBed.inject(MeetingsFacade);
    const set = vi.spyOn(facade, 'setSummaryInstructionDraft');

    const fixture = await createFixture();

    const pane = fixture.debugElement.query(By.directive(MeetingDetailPaneComponent));
    pane.componentInstance.summaryInstructionDraftChanged.emit({
      template: 'key-points',
      draft: { text: 'Focus on pricing', includeGeneral: false },
    });
    fixture.detectChanges();

    expect(set).toHaveBeenCalledWith(toMeetingId('m1'), 'key-points', { text: 'Focus on pricing', includeGeneral: false });
    expect(facade.summaryInstructionDraft(toMeetingId('m1'), 'key-points')).toEqual({
      text: 'Focus on pricing',
      includeGeneral: false,
    });
    expect(pane.componentInstance.summaryInstructionDrafts().get('key-points')).toEqual({
      text: 'Focus on pricing',
      includeGeneral: false,
    });
  });

  it('routes the pane regenerateRequested through summarize() onto the facade', async () => {
    repository.seed([meeting]);
    routeParamMap.next(convertToParamMap({ id: 'm1' }));
    const facade = TestBed.inject(MeetingsFacade);
    const summarize = vi.spyOn(facade, 'summarizeMeeting');

    const fixture = await createFixture();

    const pane = fixture.debugElement.query(By.directive(MeetingDetailPaneComponent));
    pane.componentInstance.regenerateRequested.emit('key-points');
    await flushMicrotasks();
    fixture.detectChanges();

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0]?.[0]).toBe(toMeetingId('m1'));
    expect(summarize.mock.calls[0]?.[1].name).toBe('key-points');
  });

  it('regenerate button carries aria-disabled, aria-busy, a reason title, and a busy-hint while generating elsewhere', async () => {
    const withSummary: Meeting = {
      ...meeting,
      summaries: [
        { template: 'key-points', markdown: '# Old', createdAt: new Date(), language: 'en', stale: false },
      ],
    };
    repository.seed([withSummary]);
    routeParamMap.next(convertToParamMap({ id: 'm1' }));

    const fixture = await createFixture();
    const pane = fixture.debugElement.query(By.directive(MeetingDetailPaneComponent));
    pane.componentInstance.selectTab('key-points');
    fixture.detectChanges();

    const idleButton: HTMLButtonElement = fixture.nativeElement.querySelector('.regenerate-button');
    expect(idleButton).toBeTruthy();
    expect(idleButton.getAttribute('aria-disabled')).toBe(String(idleButton.disabled));
    expect(idleButton.getAttribute('aria-busy')).not.toBeNull();
    expect(idleButton.title).toContain('Regenerate');

    TestBed.inject(MeetingsStore).setSummarizingKey({ template: 'meeting-notes', language: 'en' });
    fixture.detectChanges();

    const busyButton: HTMLButtonElement = fixture.nativeElement.querySelector('.regenerate-button');
    expect(busyButton.disabled).toBe(true);
    expect(busyButton.getAttribute('aria-disabled')).toBe('true');
    expect(busyButton.title).toContain('meeting-notes');
    expect(fixture.nativeElement.querySelector('.pane-toolbar-summary .busy-hint')?.textContent).toContain(
      'meeting-notes',
    );
  });

  it('regenerate confirm uses the edited draft (existing instructions then edit)', async () => {
    const withSummary: Meeting = {
      ...meeting,
      summaries: [
        { template: 'key-points', markdown: '# Old', createdAt: new Date(), language: 'en', stale: false },
      ],
    };
    repository.seed([withSummary]);
    routeParamMap.next(convertToParamMap({ id: 'm1' }));
    const summarizer = TestBed.inject(SummarizerPort) as InMemorySummarizerFake;

    const fixture = await createFixture();
    const pane = fixture.debugElement.query(By.directive(MeetingDetailPaneComponent));
    pane.componentInstance.selectTab('key-points');
    fixture.detectChanges();
    pane.componentInstance.summaryInstructionDraftChanged.emit({
      template: 'key-points',
      draft: { text: 'Focus on pricing', includeGeneral: true },
    });
    fixture.detectChanges();
    pane.componentInstance.summaryInstructionDraftChanged.emit({
      template: 'key-points',
      draft: { text: 'Focus on risks', includeGeneral: true },
    });
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.regenerate-button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(summarizer.lastInstructions).toBeUndefined();
    expect(
      fixture.nativeElement.querySelector('app-regenerate-instructions-dialog [role="dialog"]')?.getAttribute('aria-modal'),
    ).toBe('true');
    expect(fixture.nativeElement.querySelector('.regenerate-confirm')).toBeNull();
    (fixture.nativeElement.querySelector('app-regenerate-instructions-dialog .confirm') as HTMLButtonElement).click();
    await flushMicrotasks();
    fixture.detectChanges();
    await flushMicrotasks();
    fixture.detectChanges();

    expect(summarizer.lastInstructions).toEqual({ text: 'Focus on risks', includeGeneral: true });
  });

  it('regenerate confirm uses the default draft after Remove (existing instructions then remove)', async () => {
    const withSummary: Meeting = {
      ...meeting,
      summaries: [
        { template: 'key-points', markdown: '# Old', createdAt: new Date(), language: 'en', stale: false },
      ],
    };
    repository.seed([withSummary]);
    routeParamMap.next(convertToParamMap({ id: 'm1' }));
    const summarizer = TestBed.inject(SummarizerPort) as InMemorySummarizerFake;

    const fixture = await createFixture();
    const pane = fixture.debugElement.query(By.directive(MeetingDetailPaneComponent));
    pane.componentInstance.selectTab('key-points');
    fixture.detectChanges();
    pane.componentInstance.summaryInstructionDraftChanged.emit({
      template: 'key-points',
      draft: { text: 'Focus on pricing', includeGeneral: true },
    });
    fixture.detectChanges();
    pane.componentInstance.summaryInstructionDraftChanged.emit({
      template: 'key-points',
      draft: { text: '', includeGeneral: true },
    });
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.regenerate-button') as HTMLButtonElement).click();
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('app-regenerate-instructions-dialog .confirm') as HTMLButtonElement).click();
    await flushMicrotasks();
    fixture.detectChanges();
    await flushMicrotasks();
    fixture.detectChanges();

    expect(summarizer.lastInstructions).toEqual({ text: '', includeGeneral: true });
  });

  it('regenerate confirm uses a newly added draft (no prior instructions then add)', async () => {
    const withSummary: Meeting = {
      ...meeting,
      summaries: [
        { template: 'key-points', markdown: '# Old', createdAt: new Date(), language: 'en', stale: false },
      ],
    };
    repository.seed([withSummary]);
    routeParamMap.next(convertToParamMap({ id: 'm1' }));
    const summarizer = TestBed.inject(SummarizerPort) as InMemorySummarizerFake;

    const fixture = await createFixture();
    const pane = fixture.debugElement.query(By.directive(MeetingDetailPaneComponent));
    pane.componentInstance.selectTab('key-points');
    fixture.detectChanges();
    pane.componentInstance.summaryInstructionDraftChanged.emit({
      template: 'key-points',
      draft: { text: 'Focus on pricing', includeGeneral: true },
    });
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.regenerate-button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.regenerate-confirm')).toBeNull();
    (fixture.nativeElement.querySelector('app-regenerate-instructions-dialog .confirm') as HTMLButtonElement).click();
    await flushMicrotasks();
    fixture.detectChanges();
    await flushMicrotasks();
    fixture.detectChanges();

    expect(summarizer.lastInstructions).toEqual({ text: 'Focus on pricing', includeGeneral: true });
  });

  it('regenerate confirm omits general guidelines after toggle-off (guidelines set then toggle off)', async () => {
    const withSummary: Meeting = {
      ...meeting,
      summaries: [
        { template: 'key-points', markdown: '# Old', createdAt: new Date(), language: 'en', stale: false },
      ],
    };
    repository.seed([withSummary]);
    routeParamMap.next(convertToParamMap({ id: 'm1' }));
    const summarizer = TestBed.inject(SummarizerPort) as InMemorySummarizerFake;
    await summarizer.setGuidelines('Use bullet points.');

    const fixture = await createFixture();
    const pane = fixture.debugElement.query(By.directive(MeetingDetailPaneComponent));
    pane.componentInstance.selectTab('key-points');
    fixture.detectChanges();
    pane.componentInstance.summaryInstructionDraftChanged.emit({
      template: 'key-points',
      draft: { text: '', includeGeneral: false },
    });
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.regenerate-button') as HTMLButtonElement).click();
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('app-regenerate-instructions-dialog .confirm') as HTMLButtonElement).click();
    await flushMicrotasks();
    fixture.detectChanges();
    await flushMicrotasks();
    fixture.detectChanges();

    expect(summarizer.lastInstructions).toEqual({ text: '', includeGeneral: false });
  });

  it('regenerate success upserts the fresh summary and clears stale on the selected meeting', async () => {
    const staleMeeting: Meeting = {
      ...meeting,
      summaries: [
        { template: 'key-points', markdown: '# Old', createdAt: new Date(), language: 'en', stale: true },
      ],
    };
    repository.seed([staleMeeting]);
    routeParamMap.next(convertToParamMap({ id: 'm1' }));
    const facade = TestBed.inject(MeetingsFacade);

    const fixture = await createFixture();

    const pane = fixture.debugElement.query(By.directive(MeetingDetailPaneComponent));
    pane.componentInstance.regenerateRequested.emit('key-points');
    await flushMicrotasks();
    fixture.detectChanges();
    await flushMicrotasks();
    fixture.detectChanges();

    const summaries = facade.selectedMeeting()?.summaries ?? [];
    expect(summaries.length).toBe(1);
    expect(summaries[0]?.stale).toBe(false);
    expect(facade.summarizingKey()).toBeNull();
    expect(facade.error()).toBeUndefined();
  });
});
