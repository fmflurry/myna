import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { toMeetingId } from '../../core/models/meeting.model';
import { AppInfoPort } from '../../core/ports/app-info.port';
import { FileDialogPort } from '../../core/ports/file-dialog.port';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';
import { ModelsStatusPort } from '../../core/ports/models-status.port';
import { PreferencesPort } from '../../core/ports/preferences.port';
import { RecorderPort } from '../../core/ports/recorder.port';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { TemplateRepositoryPort } from '../../core/ports/template-repository.port';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import type { Summary } from '../../core/models/summary.model';
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
import { SummarizeMeetingUseCase } from '../use-cases/summarize-meeting.usecase';
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

/**
 * Regression coverage for "every summary tab shows the same loader while
 * one generates" (see the task brief), at the facade/store boundary:
 * `summarizingKey` must identify exactly the (template, language) pair in
 * flight, capture it ONCE at the moment generation starts (never reactively
 * off the language picker), and clear it on every settlement path — success,
 * error, and cancellation alike. Split into its own file to keep
 * `meetings.facade.spec.ts` under the project's max-lines limit.
 */
describe('MeetingsFacade summarizingKey', () => {
  let facade: MeetingsFacade;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideMeetings(), ...FAKE_PORT_OVERRIDES],
    });
    facade = TestBed.inject(MeetingsFacade);
  });

  it('sets the summarizingKey to the requested template and the currently selected language while in flight', async () => {
    const useCase = TestBed.inject(SummarizeMeetingUseCase);
    let resolveSummary: (summary: Summary) => void = () => undefined;
    vi.spyOn(useCase, 'summarize').mockImplementation(
      () => new Promise<Summary>((resolve) => { resolveSummary = resolve; }),
    );
    facade.selectSummaryLanguage('en');

    const pending = facade.summarizeMeeting(toMeetingId('m-1'), {
      name: 'meeting-notes',
      description: 'Meeting notes',
      prompt: 'p',
    });

    expect(facade.summarizingKey()).toEqual({ template: 'meeting-notes', language: 'en' });

    resolveSummary({ template: 'meeting-notes', markdown: '# Notes', createdAt: new Date(), language: 'en', stale: false });
    await pending;

    expect(facade.summarizingKey()).toBeNull();
  });

  it('keeps the in-flight summarizingKey unchanged when the language picker is switched mid-generation', async () => {
    const useCase = TestBed.inject(SummarizeMeetingUseCase);
    let resolveSummary: (summary: Summary) => void = () => undefined;
    vi.spyOn(useCase, 'summarize').mockImplementation(
      () => new Promise<Summary>((resolve) => { resolveSummary = resolve; }),
    );
    facade.selectSummaryLanguage('en');

    const pending = facade.summarizeMeeting(toMeetingId('m-1'), {
      name: 'meeting-notes',
      description: 'Meeting notes',
      prompt: 'p',
    });
    facade.selectSummaryLanguage('fr');

    // meeting-notes/en is still the pair generating — meeting-notes/fr is a
    // DIFFERENT tab and must be free to show its own state.
    expect(facade.summarizingKey()).toEqual({ template: 'meeting-notes', language: 'en' });

    resolveSummary({ template: 'meeting-notes', markdown: '# Notes', createdAt: new Date(), language: 'en', stale: false });
    await pending;
  });

  it('clears the summarizingKey once generation settles with an error, not just on success', async () => {
    const useCase = TestBed.inject(SummarizeMeetingUseCase);
    vi.spyOn(useCase, 'summarize').mockRejectedValue(new Error('boom'));

    await facade.summarizeMeeting(toMeetingId('m-1'), {
      name: 'meeting-notes',
      description: 'Meeting notes',
      prompt: 'p',
    });

    expect(facade.summarizingKey()).toBeNull();
    expect(facade.error()).toBeDefined();
  });

  it('clears the summarizingKey on cancellation', async () => {
    const useCase = TestBed.inject(SummarizeMeetingUseCase);
    vi.spyOn(useCase, 'summarize').mockImplementation(() => new Promise<Summary>(() => undefined));
    facade.selectSummaryLanguage('en');
    void facade.summarizeMeeting(toMeetingId('m-1'), {
      name: 'meeting-notes',
      description: 'Meeting notes',
      prompt: 'p',
    });
    expect(facade.summarizingKey()).not.toBeNull();

    await facade.cancelSummarization();

    expect(facade.summarizingKey()).toBeNull();
  });
});
