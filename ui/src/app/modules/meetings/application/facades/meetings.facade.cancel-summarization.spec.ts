import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { toMeetingId } from '../../core/models/meeting.model';
import { MeetingsError } from '../../core/models/recording-state.model';
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

/**
 * `provideMeetings()` binds the real Tauri adapters (correct for the
 * shipped app), so every fake port used below is layered on top via
 * explicit overrides — this spec exercises the facade against fakes,
 * not against a live Tauri runtime.
 */
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

describe('MeetingsFacade cancelSummarization', () => {
  let facade: MeetingsFacade;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideMeetings(), ...FAKE_PORT_OVERRIDES],
    });
    facade = TestBed.inject(MeetingsFacade);
  });

  it('keeps summarizingKey/summarizing set across cancelSummarization until the pending summarize settles, and never surfaces the cancellation as an error', async () => {
    const useCase = TestBed.inject(SummarizeMeetingUseCase);
    let rejectSummary: (reason: unknown) => void = () => undefined;
    vi.spyOn(useCase, 'summarize').mockImplementation(
      () => new Promise<Summary>((_resolve, reject) => { rejectSummary = reject; }),
    );

    const pending = facade.summarizeMeeting(toMeetingId('m-1'), {
      name: 'key-points',
      description: 'Key points',
      prompt: 'Summarize the key points.',
    });
    expect(facade.summarizingKey()).not.toBeNull();
    expect(facade.summarizing()).toBe(true);

    const cancelResult = await facade.cancelSummarization();

    // cancelSummarization() must NOT release the busy state by itself — the
    // underlying summarize() call is still in flight until the backend
    // actually tears it down and its promise settles.
    expect(cancelResult).toBeUndefined();
    expect(facade.summarizingKey()).not.toBeNull();
    expect(facade.summarizing()).toBe(true);

    rejectSummary(new MeetingsError('LLM', 'operation was cancelled'));
    await pending;

    expect(facade.summarizingKey()).toBeNull();
    expect(facade.summarizing()).toBe(false);
    // A user-initiated cancellation is not a failure — it must never land
    // in the shared error banner.
    expect(facade.error()).toBeUndefined();
  });
});
