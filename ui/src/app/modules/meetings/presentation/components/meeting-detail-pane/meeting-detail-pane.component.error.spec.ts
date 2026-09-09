import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import type { MeetingsErrorInfo } from '../../../application/stores/meetings.store';
import { summaryCacheKey } from '../../../application/stores/summary-cache.model';
import { InMemoryAppInfoFake } from '../../../application/testing/in-memory-app-info.fake';
import { InMemoryFileDialogFake } from '../../../application/testing/in-memory-file-dialog.fake';
import { InMemoryMeetingRepositoryFake } from '../../../application/testing/in-memory-meeting-repository.fake';
import { InMemoryModelsStatusFake } from '../../../application/testing/in-memory-models-status.fake';
import { InMemoryPreferencesFake } from '../../../application/testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../../../application/testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../../../application/testing/in-memory-summarizer.fake';
import { InMemoryTemplateRepositoryFake } from '../../../application/testing/in-memory-template-repository.fake';
import { InMemoryTranscriberFake } from '../../../application/testing/in-memory-transcriber.fake';
import { GetSummaryUseCase } from '../../../application/use-cases/get-summary.usecase';
import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { SummaryTemplate } from '../../../core/models/summary-template.model';
import { AppInfoPort } from '../../../core/ports/app-info.port';
import { FileDialogPort } from '../../../core/ports/file-dialog.port';
import { MeetingRepositoryPort } from '../../../core/ports/meeting-repository.port';
import { ModelsStatusPort } from '../../../core/ports/models-status.port';
import { PreferencesPort } from '../../../core/ports/preferences.port';
import { RecorderPort } from '../../../core/ports/recorder.port';
import { SummarizerPort } from '../../../core/ports/summarizer.port';
import { TemplateRepositoryPort } from '../../../core/ports/template-repository.port';
import { TranscriberPort } from '../../../core/ports/transcriber.port';
import { provideMeetings } from '../../../meetings.providers';
import { MeetingDetailPaneComponent } from './meeting-detail-pane.component';

/**
 * RED-confirmed regression for the "nothing happened at all" silent-failure
 * report: `error()` reaches this component correctly, but the OLD template
 * only rendered `<app-error-state>` inside the `@else` (meeting-selected)
 * branch of a three-way `@if (!modelsReady()) {…} @else if (!meeting()) {…}
 * @else {…}` chain. When an import is rejected before any placeholder
 * meeting exists, `meeting()` stays `undefined`, the welcome-panel branch
 * renders instead, and the error was silently dropped — never rendered
 * anywhere.
 *
 * Every pre-existing spec in this file (and its siblings) seeds a selected
 * meeting before asserting on error rendering, so none of them ever
 * exercised `meeting() === undefined` AND `error()` set at the same time —
 * the exact gap this file closes. See `meeting-detail-pane.component.html`
 * for the fix: the error is now hoisted out of the branch chain entirely.
 */
describe('MeetingDetailPaneComponent error visibility with no meeting selected', () => {
  const templates: SummaryTemplate[] = [{ name: 'key-points', description: 'Key points', prompt: 'p' }];
  const pathError: MeetingsErrorInfo = {
    code: 'PATH',
    message: 'source path is inside the meetings root and would be overwritten by the import',
  };

  const createFixture = (error: MeetingsErrorInfo | undefined) => {
    const fixture = TestBed.createComponent(MeetingDetailPaneComponent);
    fixture.componentRef.setInput('modelsReady', true);
    fixture.componentRef.setInput('recordingState', 'idle');
    fixture.componentRef.setInput('captureSource', 'microphone');
    fixture.componentRef.setInput('templates', templates);
    fixture.componentRef.setInput('selectedSummaryLanguage', 'en');
    fixture.componentRef.setInput('error', error);
    fixture.detectChanges();
    return fixture;
  };

  it('renders app-error-state when no meeting is selected and an error is set (was previously dropped)', () => {
    const fixture = createFixture(pathError);

    const errorState = fixture.nativeElement.querySelector('app-error-state');
    expect(errorState).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('The selected file location is invalid.');
  });

  it('still renders the welcome panel underneath the hoisted error', () => {
    const fixture = createFixture(pathError);

    expect(fixture.nativeElement.querySelector('app-welcome-panel')).toBeTruthy();
  });

  it('renders no error-state when error is unset and no meeting is selected', () => {
    const fixture = createFixture(undefined);

    expect(fixture.nativeElement.querySelector('app-error-state')).toBeNull();
  });

  it('re-emits retryRequested from the hoisted error-state', () => {
    const fixture = createFixture(pathError);
    const emitted: number[] = [];
    fixture.componentInstance.retryRequested.subscribe(() => emitted.push(1));

    fixture.nativeElement.querySelector('app-error-state .retry').click();

    expect(emitted).toEqual([1]);
  });

  it('re-emits dismissRequested from the hoisted error-state Close button', () => {
    const fixture = createFixture(pathError);
    const dismissed: number[] = [];
    const retried: number[] = [];
    fixture.componentInstance.dismissRequested.subscribe(() => dismissed.push(1));
    fixture.componentInstance.retryRequested.subscribe(() => retried.push(1));

    fixture.nativeElement.querySelector('app-error-state .dismiss').click();

    expect(dismissed).toEqual([1]);
    expect(retried).toEqual([]);
  });

  it('removes the banner once the owner clears the error input (what Close triggers upstream)', () => {
    const fixture = createFixture(pathError);
    expect(fixture.nativeElement.querySelector('app-error-state')).toBeTruthy();

    fixture.componentRef.setInput('error', undefined);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-error-state')).toBeNull();
  });
});

/**
 * Reproduces the summary-load retry loop end to end, through the REAL
 * facade, exactly as `meetings-shell.page.ts` wires it:
 *
 *   pane `effect()` reads `summaryCache()` → `findUnloadedSummaryRequest`
 *   → `summaryLoadRequested` → `facade.loadSummary` → `runLoadSummary`
 *   → on rejection `store.clearSummaryCacheEntry` → `summaryCache()` changes
 *   → the effect re-fires with `has(key) === false` → emit again → …
 *
 * Each loop iteration below does what the shell does between two change
 * detection passes: mirror `facade.summaryCache()` into the pane's input and
 * let any in-flight `loadSummary` settle. A meeting with one persisted ref
 * (`markdown: ''`, how the mapper always hands a persisted ref to the UI) and
 * a `GetSummaryUseCase` that rejects must produce at most ONE IPC call across
 * many passes — today it produces one per pass, at IPC speed, unbounded.
 */
describe('MeetingDetailPaneComponent summary-load retry loop', () => {
  const FAKE_PORT_OVERRIDES = [
    { provide: MeetingRepositoryPort, useClass: InMemoryMeetingRepositoryFake },
    { provide: RecorderPort, useClass: InMemoryRecorderFake },
    { provide: SummarizerPort, useClass: InMemorySummarizerFake },
    { provide: TranscriberPort, useClass: InMemoryTranscriberFake },
    { provide: TemplateRepositoryPort, useClass: InMemoryTemplateRepositoryFake },
    { provide: ModelsStatusPort, useClass: InMemoryModelsStatusFake },
    { provide: FileDialogPort, useClass: InMemoryFileDialogFake },
    { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
    { provide: AppInfoPort, useClass: InMemoryAppInfoFake },
  ];
  const MEETING_ID = toMeetingId('m-1');
  const TEMPLATE = 'key-points';
  const LANGUAGE = 'en';
  /** Well above anything a human could trigger by tab-switching; a loop shows up as one request per pass. */
  const CHANGE_DETECTION_PASSES = 20;
  const templates: SummaryTemplate[] = [{ name: TEMPLATE, description: 'Key points', prompt: 'p' }];
  const meetingWithPersistedRef: Meeting = {
    id: MEETING_ID,
    title: 'Standup',
    createdAt: new Date('2026-01-15T10:00:00Z'),
    durationSec: 60,
    transcript: { segments: [] },
    summaries: [{ template: TEMPLATE, markdown: '', createdAt: new Date('2026-01-15T10:05:00Z'), language: LANGUAGE, stale: false }],
    archived: false,
    hasAudio: false,
    hasSystemTrack: false,
    droppedAudioChunks: 0,
  };

  let facade: MeetingsFacade;
  let getSummaryUseCase: GetSummaryUseCase;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideMeetings(), ...FAKE_PORT_OVERRIDES],
    });
    facade = TestBed.inject(MeetingsFacade);
    getSummaryUseCase = TestBed.inject(GetSummaryUseCase);
  });

  /**
   * Mounts the pane on the template tab, wires `summaryLoadRequested` to the
   * facade like the shell does, then drives N change-detection passes,
   * mirroring the facade's cache into the input between each. Returns how
   * many times the pane asked for a load.
   */
  const driveShellLoop = async (): Promise<number> => {
    const fixture = TestBed.createComponent(MeetingDetailPaneComponent);
    fixture.componentRef.setInput('modelsReady', true);
    fixture.componentRef.setInput('recordingState', 'idle');
    fixture.componentRef.setInput('captureSource', 'microphone');
    fixture.componentRef.setInput('templates', templates);
    fixture.componentRef.setInput('selectedSummaryLanguage', LANGUAGE);
    fixture.componentRef.setInput('meeting', meetingWithPersistedRef);
    let requests = 0;
    const inFlight: Promise<void>[] = [];
    fixture.componentInstance.summaryLoadRequested.subscribe((request) => {
      requests += 1;
      inFlight.push(facade.loadSummary(request.meetingId, request.template, request.language));
    });
    fixture.componentInstance.selectTab(TEMPLATE);

    for (let pass = 0; pass < CHANGE_DETECTION_PASSES; pass += 1) {
      fixture.componentRef.setInput('summaryCache', facade.summaryCache());
      fixture.detectChanges();
      await Promise.all(inFlight.splice(0));
    }
    return requests;
  };

  it('requests a failing summary load at most once across many change-detection passes (was: once per pass)', async () => {
    const getSpy = vi.spyOn(getSummaryUseCase, 'get').mockRejectedValue(new Error('meeting.json unreadable'));

    const requests = await driveShellLoop();

    expect(requests).toBeLessThanOrEqual(1);
    expect(getSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('leaves the cache carrying an entry for the failed key so the effect guard holds', async () => {
    vi.spyOn(getSummaryUseCase, 'get').mockRejectedValue(new Error('meeting.json unreadable'));

    await driveShellLoop();

    expect(facade.summaryCache().has(summaryCacheKey(MEETING_ID, TEMPLATE, LANGUAGE))).toBe(true);
    expect(facade.error()).toBeDefined();
  });

  it('Ok(None) — no summary saved yet — requests exactly once and settles on the empty state', async () => {
    const getSpy = vi.spyOn(getSummaryUseCase, 'get');

    const requests = await driveShellLoop();

    expect(requests).toBe(1);
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(facade.summaryCache().get(summaryCacheKey(MEETING_ID, TEMPLATE, LANGUAGE))).toEqual({ status: 'empty' });
    expect(facade.error()).toBeUndefined();
  });

  it('a successful load requests exactly once and populates the cache', async () => {
    const summarizer = TestBed.inject(SummarizerPort) as InMemorySummarizerFake;
    const createdAt = new Date('2026-01-15T10:05:00Z');
    summarizer.seedSummary(MEETING_ID, { template: TEMPLATE, markdown: '# Key points', createdAt, language: LANGUAGE, stale: false });
    const getSpy = vi.spyOn(getSummaryUseCase, 'get');

    const requests = await driveShellLoop();

    expect(requests).toBe(1);
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(facade.summaryCache().get(summaryCacheKey(MEETING_ID, TEMPLATE, LANGUAGE))).toEqual({
      status: 'loaded',
      summary: { template: TEMPLATE, markdown: '# Key points', createdAt, language: LANGUAGE, stale: false },
    });
    expect(facade.error()).toBeUndefined();
  });
});
