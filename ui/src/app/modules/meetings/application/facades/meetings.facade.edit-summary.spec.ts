import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { toMeetingId } from '../../core/models/meeting.model';
import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import type { Summary } from '../../core/models/summary.model';
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
import { MeetingsStore } from '../stores/meetings.store';
import { InMemoryAppInfoFake } from '../testing/in-memory-app-info.fake';
import { InMemoryFileDialogFake } from '../testing/in-memory-file-dialog.fake';
import { InMemoryMeetingRepositoryFake } from '../testing/in-memory-meeting-repository.fake';
import { InMemoryModelsStatusFake } from '../testing/in-memory-models-status.fake';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { InMemoryTemplateRepositoryFake } from '../testing/in-memory-template-repository.fake';
import { InMemoryTranscriberFake } from '../testing/in-memory-transcriber.fake';
import { EditSummaryUseCase } from '../use-cases/edit-summary.usecase';
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

const meetingWithSummaryRef = (markdown: string): Meeting => ({
  id: MEETING_ID,
  title: 'Standup',
  createdAt: new Date('2026-01-15T10:00:00Z'),
  durationSec: 60,
  transcript: { segments: [] },
  summaries: [
    { template: 'key-points', markdown, createdAt: new Date('2026-01-15T10:05:00Z'), language: 'en', stale: false },
  ],
  archived: false,
  hasAudio: false,
  hasSystemTrack: false,
  droppedAudioChunks: 0,
});

const cachedSummary = (markdown: string): Summary => ({
  template: 'key-points',
  markdown,
  createdAt: new Date('2026-01-15T10:05:00Z'),
  language: 'en',
  stale: false,
});

/**
 * Covers the two read paths the detail pane uses for a persisted summary:
 * the summary-cache `'loaded'` entry AND the selected meeting's `summaries`
 * ref markdown. Both must be patched on success; neither may be touched on
 * failure (never optimistic).
 */
describe('MeetingsFacade editSummary', () => {
  let facade: MeetingsFacade;
  let store: MeetingsStore;
  let useCase: EditSummaryUseCase;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideMeetings(), ...FAKE_PORT_OVERRIDES],
    });
    facade = TestBed.inject(MeetingsFacade);
    store = TestBed.inject(MeetingsStore);
    useCase = TestBed.inject(EditSummaryUseCase);
  });

  it('patches BOTH the loaded cache entry and the selected meeting summaries ref markdown on success', async () => {
    store.setSelectedMeeting(meetingWithSummaryRef(''));
    store.setSummaryCacheResult(MEETING_ID, 'key-points', 'en', cachedSummary('# Original'));
    const edited: Summary = { template: 'key-points', markdown: '# Edited', createdAt: new Date('2026-01-15T10:06:00Z'), language: 'en', stale: false };
    vi.spyOn(useCase, 'edit').mockResolvedValue(edited);

    await facade.editSummary(MEETING_ID, 'key-points', 'en', '# Edited');

    const cacheEntry = store.getSummaryCacheEntry(MEETING_ID, 'key-points', 'en');
    expect(cacheEntry?.status).toBe('loaded');
    expect(cacheEntry?.summary?.markdown).toBe('# Edited');
    const ref = store.selectedMeeting()?.summaries.find((summary) => summary.template === 'key-points' && summary.language === 'en');
    expect(ref?.markdown).toBe('# Edited');
    expect(facade.error()).toBeUndefined();
  });

  it('leaves the meeting JSON untouched on success (no applyMeetingMutation)', async () => {
    const meeting = meetingWithSummaryRef('');
    store.setSelectedMeeting(meeting);
    store.setSummaryCacheResult(MEETING_ID, 'key-points', 'en', cachedSummary('# Original'));
    const edited: Summary = { template: 'key-points', markdown: '# Edited', createdAt: new Date('2026-01-15T10:06:00Z'), language: 'en', stale: false };
    vi.spyOn(useCase, 'edit').mockResolvedValue(edited);

    await facade.editSummary(MEETING_ID, 'key-points', 'en', '# Edited');

    const selected = store.selectedMeeting();
    expect(selected?.title).toBe(meeting.title);
    // flurryx clones slot data on every write, so reference identity across
    // the store boundary is impossible — assert the transcript CONTENT is
    // untouched instead.
    expect(selected?.transcript).toEqual(meeting.transcript);
    expect(selected?.durationSec).toBe(meeting.durationSec);
  });

  it('mutates neither the cache entry nor the ref markdown on failure, and surfaces the error', async () => {
    store.setSelectedMeeting(meetingWithSummaryRef('# Original'));
    store.setSummaryCacheResult(MEETING_ID, 'key-points', 'en', cachedSummary('# Original'));
    vi.spyOn(useCase, 'edit').mockRejectedValue(new Error('boom'));

    await facade.editSummary(MEETING_ID, 'key-points', 'en', '# Edited');

    const cacheEntry = store.getSummaryCacheEntry(MEETING_ID, 'key-points', 'en');
    expect(cacheEntry?.summary?.markdown).toBe('# Original');
    const ref = store.selectedMeeting()?.summaries.find((summary) => summary.template === 'key-points' && summary.language === 'en');
    expect(ref?.markdown).toBe('# Original');
    expect(facade.error()).toBeDefined();
  });

  it('patches the edited meeting cache entry but leaves a DIFFERENT selected meeting ref untouched', async () => {
    const otherId: MeetingId = toMeetingId('m-2');
    store.setSelectedMeeting(meetingWithSummaryRef('# Original'));
    store.setSummaryCacheResult(otherId, 'key-points', 'en', cachedSummary('# Original'));
    const edited: Summary = { template: 'key-points', markdown: '# Edited', createdAt: new Date('2026-01-15T10:06:00Z'), language: 'en', stale: false };
    vi.spyOn(useCase, 'edit').mockResolvedValue(edited);

    await facade.editSummary(otherId, 'key-points', 'en', '# Edited');

    // The selected meeting (m-1) is not the edited one — its ref stays as-is.
    const ref = store.selectedMeeting()?.summaries[0];
    expect(ref?.markdown).toBe('# Original');
    // The edited meeting's own cache entry is still patched.
    const cacheEntry = store.getSummaryCacheEntry(otherId, 'key-points', 'en');
    expect(cacheEntry?.summary?.markdown).toBe('# Edited');
  });
});
