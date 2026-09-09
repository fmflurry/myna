import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { toMeetingId } from '../../core/models/meeting.model';
import type { Meeting } from '../../core/models/meeting.model';
import { AppInfoPort } from '../../core/ports/app-info.port';
import { FileDialogPort } from '../../core/ports/file-dialog.port';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';
import { ModelsStatusPort } from '../../core/ports/models-status.port';
import { PreferencesPort } from '../../core/ports/preferences.port';
import { RecorderPort } from '../../core/ports/recorder.port';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { TemplateRepositoryPort } from '../../core/ports/template-repository.port';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import { provideMeetings } from '../../meetings.providers';
import { findUnloadedSummaryRequest } from '../../presentation/components/meeting-detail-pane/meeting-detail-pane.component.support';
import { summaryCacheKey } from '../stores/summary-cache.model';
import { InMemoryAppInfoFake } from '../testing/in-memory-app-info.fake';
import { InMemoryFileDialogFake } from '../testing/in-memory-file-dialog.fake';
import { InMemoryMeetingRepositoryFake } from '../testing/in-memory-meeting-repository.fake';
import { InMemoryModelsStatusFake } from '../testing/in-memory-models-status.fake';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { InMemoryTemplateRepositoryFake } from '../testing/in-memory-template-repository.fake';
import { InMemoryTranscriberFake } from '../testing/in-memory-transcriber.fake';
import { GetSummaryUseCase } from '../use-cases/get-summary.usecase';
import { MeetingsFacade } from './meetings.facade';

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
/** Mirrors the detail pane's private `TRANSCRIPT_TAB` constant — the tab that never requests a summary load. */
const TRANSCRIPT_TAB = 'transcript';

/**
 * A meeting whose summary ref survived a restart: the mapper always hands the
 * UI `markdown: ''` for a persisted ref (see `summary.mapper.ts`), which is
 * exactly what makes {@link findUnloadedSummaryRequest} ask for a fetch.
 */
const meetingWithPersistedRef = (): Meeting => ({
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
});

/**
 * Pins the contract between `runLoadSummary` (facade) and
 * `findUnloadedSummaryRequest` (detail pane effect): once a load has been
 * attempted for a (meeting, template, language) key — whether it resolved,
 * resolved `null`, or REJECTED — the cache must carry an entry for that key,
 * so the pane's effect never asks for it again on its own.
 *
 * The rejection path is the regression: `runLoadSummary` currently deletes
 * the key on failure ("so the next tab visit retries"), but the pane's
 * `effect()` re-reads `summaryCache()`, sees the key gone, and re-requests
 * immediately — a self-retriggering IPC loop with no cap or backoff.
 */
describe('MeetingsFacade loadSummary after a rejected get_summary', () => {
  let facade: MeetingsFacade;
  let getSummaryUseCase: GetSummaryUseCase;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideMeetings(), ...FAKE_PORT_OVERRIDES],
    });
    facade = TestBed.inject(MeetingsFacade);
    getSummaryUseCase = TestBed.inject(GetSummaryUseCase);
  });

  it('leaves a terminal cache entry for the key so the detail pane does not re-request it', async () => {
    vi.spyOn(getSummaryUseCase, 'get').mockRejectedValue(new Error('meeting.json unreadable'));
    const meeting = meetingWithPersistedRef();

    await facade.loadSummary(MEETING_ID, TEMPLATE, LANGUAGE);

    expect(facade.summaryCache().has(summaryCacheKey(MEETING_ID, TEMPLATE, LANGUAGE))).toBe(true);
    expect(findUnloadedSummaryRequest(meeting, TEMPLATE, TRANSCRIPT_TAB, LANGUAGE, facade.summaryCache())).toBeUndefined();
  });

  it('does not re-hit IPC when loadSummary is called again for the same key after a failure', async () => {
    const getSpy = vi.spyOn(getSummaryUseCase, 'get').mockRejectedValue(new Error('meeting.json unreadable'));

    await facade.loadSummary(MEETING_ID, TEMPLATE, LANGUAGE);
    await facade.loadSummary(MEETING_ID, TEMPLATE, LANGUAGE);
    await facade.loadSummary(MEETING_ID, TEMPLATE, LANGUAGE);

    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('never records the failure as a loaded or empty summary', async () => {
    vi.spyOn(getSummaryUseCase, 'get').mockRejectedValue(new Error('meeting.json unreadable'));

    await facade.loadSummary(MEETING_ID, TEMPLATE, LANGUAGE);

    const entry = facade.summaryCache().get(summaryCacheKey(MEETING_ID, TEMPLATE, LANGUAGE));
    expect(entry?.status).not.toBe('loaded');
    expect(entry?.status).not.toBe('empty');
    expect(entry?.status).not.toBe('loading');
    expect(entry?.summary).toBeUndefined();
  });

  it('still surfaces the rejection through the facade error slot', async () => {
    vi.spyOn(getSummaryUseCase, 'get').mockRejectedValue(new Error('meeting.json unreadable'));

    await facade.loadSummary(MEETING_ID, TEMPLATE, LANGUAGE);

    expect(facade.error()).toBeDefined();
  });

  it('leaves entries for OTHER keys untouched when one key fails', async () => {
    const summarizer = TestBed.inject(SummarizerPort) as InMemorySummarizerFake;
    summarizer.seedSummary(MEETING_ID, { template: 'action-items', markdown: '# Actions', createdAt: new Date(), language: LANGUAGE, stale: false });
    await facade.loadSummary(MEETING_ID, 'action-items', LANGUAGE);
    vi.spyOn(getSummaryUseCase, 'get').mockRejectedValue(new Error('meeting.json unreadable'));

    await facade.loadSummary(MEETING_ID, TEMPLATE, LANGUAGE);

    expect(facade.summaryCache().get(summaryCacheKey(MEETING_ID, 'action-items', LANGUAGE))?.status).toBe('loaded');
  });
});

/** Good paths that must keep working: `Ok(None)` and a successful load each request exactly once and never loop. */
describe('MeetingsFacade loadSummary good paths (pin, must not regress)', () => {
  let facade: MeetingsFacade;
  let getSummaryUseCase: GetSummaryUseCase;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideMeetings(), ...FAKE_PORT_OVERRIDES],
    });
    facade = TestBed.inject(MeetingsFacade);
    getSummaryUseCase = TestBed.inject(GetSummaryUseCase);
  });

  it('Ok(None) records the empty state, stops further requests, and is not an error', async () => {
    const getSpy = vi.spyOn(getSummaryUseCase, 'get');
    const meeting = meetingWithPersistedRef();

    await facade.loadSummary(MEETING_ID, TEMPLATE, LANGUAGE);
    await facade.loadSummary(MEETING_ID, TEMPLATE, LANGUAGE);

    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(facade.summaryCache().get(summaryCacheKey(MEETING_ID, TEMPLATE, LANGUAGE))).toEqual({ status: 'empty' });
    expect(findUnloadedSummaryRequest(meeting, TEMPLATE, TRANSCRIPT_TAB, LANGUAGE, facade.summaryCache())).toBeUndefined();
    expect(facade.error()).toBeUndefined();
  });

  it('a successful load populates the cache once and stops further requests', async () => {
    const summarizer = TestBed.inject(SummarizerPort) as InMemorySummarizerFake;
    const createdAt = new Date('2026-01-15T10:05:00Z');
    summarizer.seedSummary(MEETING_ID, { template: TEMPLATE, markdown: '# Key points', createdAt, language: LANGUAGE, stale: false });
    const getSpy = vi.spyOn(getSummaryUseCase, 'get');
    const meeting = meetingWithPersistedRef();

    await facade.loadSummary(MEETING_ID, TEMPLATE, LANGUAGE);
    await facade.loadSummary(MEETING_ID, TEMPLATE, LANGUAGE);

    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(facade.summaryCache().get(summaryCacheKey(MEETING_ID, TEMPLATE, LANGUAGE))).toEqual({
      status: 'loaded',
      summary: { template: TEMPLATE, markdown: '# Key points', createdAt, language: LANGUAGE, stale: false },
    });
    expect(findUnloadedSummaryRequest(meeting, TEMPLATE, TRANSCRIPT_TAB, LANGUAGE, facade.summaryCache())).toBeUndefined();
    expect(facade.error()).toBeUndefined();
  });
});
