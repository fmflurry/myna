import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { toMeetingId } from '../../core/models/meeting.model';
import type { SummaryTemplate } from '../../core/models/summary-template.model';
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
import { InMemoryAppInfoFake } from '../testing/in-memory-app-info.fake';
import { InMemoryFileDialogFake } from '../testing/in-memory-file-dialog.fake';
import { InMemoryMeetingRepositoryFake } from '../testing/in-memory-meeting-repository.fake';
import { InMemoryModelsStatusFake } from '../testing/in-memory-models-status.fake';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { InMemoryTemplateRepositoryFake } from '../testing/in-memory-template-repository.fake';
import { InMemoryTranscriberFake } from '../testing/in-memory-transcriber.fake';
import { MeetingsFacade } from './meetings.facade';

const FAKE_PORT_OVERRIDES = [
  { provide: MeetingRepositoryPort, useClass: InMemoryMeetingRepositoryFake },
  { provide: RecorderPort, useClass: InMemoryRecorderFake },
  InMemorySummarizerFake,
  { provide: SummarizerPort, useExisting: InMemorySummarizerFake },
  { provide: TranscriberPort, useClass: InMemoryTranscriberFake },
  { provide: TemplateRepositoryPort, useClass: InMemoryTemplateRepositoryFake },
  { provide: ModelsStatusPort, useClass: InMemoryModelsStatusFake },
  { provide: FileDialogPort, useClass: InMemoryFileDialogFake },
  { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
  { provide: AppInfoPort, useClass: InMemoryAppInfoFake },
];

const TEMPLATE: SummaryTemplate = { name: 'meeting-notes', description: 'Meeting notes', prompt: 'p' };

/**
 * Covers the summary-instructions facade surface: the generation flow passing
 * the stored draft to the port (asserted via the fake's `lastInstructions`),
 * guidelines loading from the server, and `setSummaryGuidelines` updating the
 * store slot ONLY after a successful port write — never optimistic.
 */
describe('MeetingsFacade summary guidelines and drafts', () => {
  let facade: MeetingsFacade;
  let summarizer: InMemorySummarizerFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideMeetings(), ...FAKE_PORT_OVERRIDES],
    });
    facade = TestBed.inject(MeetingsFacade);
    summarizer = TestBed.inject(InMemorySummarizerFake);
  });

  it('passes the stored draft to the port when summarizing', async () => {
    const id = toMeetingId('g-1');
    facade.setSummaryInstructionDraft(id, 'meeting-notes', { text: 'Focus on risks', includeGeneral: false });

    await facade.summarizeMeeting(id, TEMPLATE);

    expect(summarizer.lastInstructions).toEqual({ text: 'Focus on risks', includeGeneral: false });
    expect(facade.error()).toBeUndefined();
  });

  it('passes the default draft when the user never edited one', async () => {
    await facade.summarizeMeeting(toMeetingId('g-2'), TEMPLATE);

    expect(summarizer.lastInstructions).toEqual({ text: '', includeGeneral: true });
  });

  it('drafts are scoped per (meeting, template): a different pair keeps its own draft', async () => {
    const id = toMeetingId('g-3');
    facade.setSummaryInstructionDraft(id, 'meeting-notes', { text: 'notes focus', includeGeneral: true });

    expect(facade.summaryInstructionDraft(id, 'action-items')).toEqual({ text: '', includeGeneral: true });
    expect(facade.summaryInstructionDraft(id, 'meeting-notes')).toEqual({ text: 'notes focus', includeGeneral: true });
  });

  it('loadSummaryGuidelines populates the slot from the port', async () => {
    await summarizer.setGuidelines('Server guidelines');

    await facade.loadSummaryGuidelines();

    expect(facade.summaryGuidelines()).toBe('Server guidelines');
    expect(facade.error()).toBeUndefined();
  });

  it('setSummaryGuidelines updates the slot only after the port write succeeds', async () => {
    vi.spyOn(summarizer, 'setGuidelines').mockRejectedValueOnce(new Error('boom'));

    await facade.setSummaryGuidelines('rejected');

    expect(facade.summaryGuidelines()).toBe('');
    expect(facade.error()).toBeDefined();

    vi.restoreAllMocks();
    await facade.setSummaryGuidelines('accepted');

    expect(facade.summaryGuidelines()).toBe('accepted');
    expect(await summarizer.getGuidelines()).toBe('accepted');
    expect(facade.error()).toBeUndefined();
  });
});
