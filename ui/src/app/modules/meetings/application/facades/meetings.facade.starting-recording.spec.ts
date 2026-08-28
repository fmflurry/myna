import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import type { Meeting } from '../../core/models/meeting.model';
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

/**
 * Split out from `meetings.facade.spec.ts` to keep that file under the
 * project's max-lines limit (see `meetings-shell.page.selection.spec.ts` for
 * the same pattern applied to a page spec). Covers the "preparing to
 * record" window: `startRecording` awaits STT model load before
 * `recordingState` ever leaves `'idle'`, so the UI needs its own signal to
 * show activity during that gap.
 */
describe('MeetingsFacade startingRecording', () => {
  let facade: MeetingsFacade;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
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
      ],
    });
    facade = TestBed.inject(MeetingsFacade);
  });

  it('is true while the model-loading start() call is in flight, and clears once settled', async () => {
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    let resolveStart!: (meeting: Meeting) => void;
    const deferred = new Promise<Meeting>((resolve) => {
      resolveStart = resolve;
    });
    vi.spyOn(recorder, 'start').mockReturnValue(deferred);
    expect(facade.startingRecording()).toBe(false);

    const pending = facade.startRecording('Standup');
    expect(facade.startingRecording()).toBe(true);

    resolveStart({ id: toMeetingId('m-1'), title: 'Standup', createdAt: new Date(), durationSec: 0, summaries: [] });
    await pending;

    expect(facade.startingRecording()).toBe(false);
  });

  it('clears even when start() fails', async () => {
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    vi.spyOn(recorder, 'start').mockRejectedValue(new Error('boom'));

    await facade.startRecording('Standup');

    expect(facade.startingRecording()).toBe(false);
    expect(facade.error()?.code).toBe('UNKNOWN');
  });
});
