import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

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

describe('MeetingsFacade recording lifecycle and list membership', () => {
  let facade: MeetingsFacade;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideMeetings(), ...FAKE_PORT_OVERRIDES],
    });
    facade = TestBed.inject(MeetingsFacade);
  });

  it('surfaces a Busy error without throwing when starting a second recording', async () => {
    await facade.startRecording('First meeting');

    await facade.startRecording('Second meeting');

    expect(facade.error()?.code).toBe('BUSY');
  });

  it('immediately adds and selects the new meeting in the meetings list once startRecording resolves', async () => {
    expect(facade.meetings()).toEqual([]);

    await facade.startRecording('Planning');

    const selected = facade.selectedMeeting();
    expect(selected).toBeDefined();
    expect(facade.meetings().length).toBe(1);
    expect(facade.meetings()[0]?.id).toBe(selected?.id);
  });

  it('keeps the started meeting as a single, updated row (no duplicate) once stopRecording resolves', async () => {
    await facade.startRecording('Planning');
    const started = facade.selectedMeeting();
    if (!started) {
      throw new Error('Expected a selected meeting after startRecording.');
    }

    await facade.stopRecording();

    expect(facade.meetings().length).toBe(1);
    expect(facade.meetings()[0]?.id).toBe(started.id);
    expect(facade.selectedMeeting()?.id).toBe(started.id);
  });

  it('removes the in-progress meeting from the list when cancelRecording resolves', async () => {
    await facade.startRecording('Planning');
    expect(facade.meetings().length).toBe(1);

    await facade.cancelRecording();

    expect(facade.meetings()).toEqual([]);
    expect(facade.selectedMeeting()).toBeUndefined();
  });

  it('leaves the list untouched when cancelRecording fails', async () => {
    await facade.startRecording('Planning');
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    vi.spyOn(recorder, 'cancel').mockRejectedValue(new Error('cancel failed'));

    await facade.cancelRecording();

    expect(facade.meetings().length).toBe(1);
    expect(facade.error()).toBeDefined();
  });

  it('clearSelection() clears the selected meeting without touching the list', async () => {
    await facade.startRecording('Planning');
    expect(facade.selectedMeeting()).toBeDefined();

    facade.clearSelection();

    expect(facade.selectedMeeting()).toBeUndefined();
    expect(facade.meetings().length).toBe(1);
  });
});
