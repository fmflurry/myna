import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { MeetingsError } from '../../core/models/recording-state.model';
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

/**
 * Regression guard for the boot-time swallowed-error race.
 *
 * `MeetingsShellPage.ngOnInit` fires nine facade calls in parallel. When
 * `checkModels()` rejected (e.g. `models_status` failed) while a later boot
 * call (`loadTemplates()`) resolved successfully, the success path's
 * `store.clearError()` wiped the models error from the shared slot — the
 * onboarding panel then rendered "Checking installed models…" forever with
 * `modelsStatus` undefined AND no visible error. A rejected call's error
 * must survive later UNRELATED successes; only a success from the same
 * source may clear it.
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

describe('MeetingsFacade boot error race', () => {
  let facade: MeetingsFacade;
  let modelsStatusPort: InMemoryModelsStatusFake;
  let templateRepository: InMemoryTemplateRepositoryFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideMeetings(), ...FAKE_PORT_OVERRIDES],
    });
    facade = TestBed.inject(MeetingsFacade);
    modelsStatusPort = TestBed.inject(ModelsStatusPort) as InMemoryModelsStatusFake;
    templateRepository = TestBed.inject(TemplateRepositoryPort) as InMemoryTemplateRepositoryFake;
  });

  it('keeps a rejected checkModels visible when an unrelated boot call resolves later', async () => {
    // Arrange: models_status rejects immediately; list_templates resolves
    // only on demand — AFTER the models rejection has already set the error.
    modelsStatusPort.status = vi.fn(() =>
      Promise.reject(new MeetingsError('STORE', 'models_status exploded')),
    );
    let releaseTemplates: ((templates: readonly SummaryTemplate[]) => void) | undefined;
    templateRepository.list = vi.fn(
      () =>
        new Promise<readonly SummaryTemplate[]>((resolve) => {
          releaseTemplates = resolve;
        }),
    );

    // Act: fire both concurrently, exactly like the shell page's ngOnInit.
    const checkModels = facade.checkModels();
    const loadTemplates = facade.loadTemplates();
    await checkModels;
    expect(facade.error()).toBeDefined();

    releaseTemplates?.([]);
    await loadTemplates;

    // Assert: the unrelated success must NOT have swallowed the models error.
    expect(facade.error()?.code).toBe('STORE');
    expect(facade.error()?.message).toBe('models_status exploded');
  });

  it('keeps a rejected checkModels visible when the background device poll succeeds', async () => {
    // Arrange: models_status rejects, exactly as at boot.
    modelsStatusPort.status = vi.fn(() =>
      Promise.reject(new MeetingsError('STORE', 'models_status exploded')),
    );
    await facade.checkModels();
    expect(facade.error()?.code).toBe('STORE');

    // Act: `DevicesFacade` re-runs `loadDevices` every DEVICE_POLL_INTERVAL_MS
    // (5s) for the life of the window. That recurring success must never
    // erase an unrelated operation's error — otherwise the onboarding panel
    // sits on "Checking installed models…" with `modelsStatus` undefined and
    // NO diagnostic at all, five seconds after boot, forever.
    await facade.loadDevices();

    // Assert
    expect(facade.error()?.code).toBe('STORE');
    expect(facade.error()?.message).toBe('models_status exploded');
    expect(facade.modelsStatus()).toBeUndefined();
  });

  it('clears the models error once checkModels itself succeeds again', async () => {
    modelsStatusPort.status = vi.fn(() =>
      Promise.reject(new MeetingsError('STORE', 'models_status exploded')),
    );
    await facade.checkModels();
    expect(facade.error()?.code).toBe('STORE');

    modelsStatusPort.status = vi.fn(() =>
      Promise.resolve({
        parakeet: { present: true, expectedFiles: [] },
        qwen: { present: true, expectedFiles: [] },
        silero: { present: true, expectedFiles: [] },
        diarization: { present: true, expectedFiles: [] },
        allPresent: true,
      }),
    );
    await facade.checkModels();

    expect(facade.error()).toBeUndefined();
    expect(facade.modelsStatus()?.allPresent).toBe(true);
  });
});
