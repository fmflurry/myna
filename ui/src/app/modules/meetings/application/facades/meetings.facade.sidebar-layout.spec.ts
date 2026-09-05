import { TestBed } from '@angular/core/testing';

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
import { SIDEBAR_COLLAPSED_PREFERENCE_KEY, SIDEBAR_WIDTH_PREFERENCE_KEY } from '../stores/meetings.store';
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

describe('MeetingsFacade — sidebar layout', () => {
  let facade: MeetingsFacade;
  let preferences: InMemoryPreferencesFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideMeetings(), ...FAKE_PORT_OVERRIDES],
    });
    facade = TestBed.inject(MeetingsFacade);
    preferences = TestBed.inject(PreferencesPort) as InMemoryPreferencesFake;
  });

  it('exposes the default sidebar width and an expanded sidebar when nothing is stored', () => {
    expect(facade.sidebarWidth()).toBe(224);
    expect(facade.sidebarCollapsed()).toBe(false);
  });

  it('forwards setSidebarWidth to the store, persisting it via PreferencesPort', () => {
    facade.setSidebarWidth(300);

    expect(facade.sidebarWidth()).toBe(300);
    expect(preferences.get(SIDEBAR_WIDTH_PREFERENCE_KEY)).toBe('300');
  });

  it('forwards setSidebarCollapsed to the store, persisting it via PreferencesPort', () => {
    facade.setSidebarCollapsed(true);

    expect(facade.sidebarCollapsed()).toBe(true);
    expect(preferences.get(SIDEBAR_COLLAPSED_PREFERENCE_KEY)).toBe('true');
  });
});
