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
import { SPLIT_RATIO_PREFERENCE_KEY, TRANSCRIPT_COLLAPSED_PREFERENCE_KEY } from '../stores/meetings.store';
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

describe('MeetingsFacade — split-workspace layout', () => {
  let facade: MeetingsFacade;
  let preferences: InMemoryPreferencesFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideMeetings(), ...FAKE_PORT_OVERRIDES],
    });
    facade = TestBed.inject(MeetingsFacade);
    preferences = TestBed.inject(PreferencesPort) as InMemoryPreferencesFake;
  });

  it('exposes the default split ratio and an expanded transcript when nothing is stored', () => {
    expect(facade.splitRatio()).toBe(0.4);
    expect(facade.transcriptCollapsed()).toBe(false);
  });

  it('forwards setSplitRatio to the store, persisting it via PreferencesPort', () => {
    facade.setSplitRatio(0.5);

    expect(facade.splitRatio()).toBe(0.5);
    expect(preferences.get(SPLIT_RATIO_PREFERENCE_KEY)).toBe('0.5');
  });

  it('forwards setTranscriptCollapsed to the store, persisting it via PreferencesPort', () => {
    facade.setTranscriptCollapsed(true);

    expect(facade.transcriptCollapsed()).toBe(true);
    expect(preferences.get(TRANSCRIPT_COLLAPSED_PREFERENCE_KEY)).toBe('true');
  });
});
