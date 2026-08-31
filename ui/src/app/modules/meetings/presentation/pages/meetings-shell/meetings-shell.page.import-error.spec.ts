import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, type ParamMap } from '@angular/router';
import { BehaviorSubject } from 'rxjs';

import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import { InMemoryAppInfoFake } from '../../../application/testing/in-memory-app-info.fake';
import { InMemoryAudioImportFake } from '../../../application/testing/in-memory-audio-import.fake';
import { InMemoryFileDialogFake } from '../../../application/testing/in-memory-file-dialog.fake';
import { InMemoryMeetingRepositoryFake } from '../../../application/testing/in-memory-meeting-repository.fake';
import { InMemoryModelsStatusFake } from '../../../application/testing/in-memory-models-status.fake';
import { InMemoryPreferencesFake } from '../../../application/testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../../../application/testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../../../application/testing/in-memory-summarizer.fake';
import { InMemoryTemplateRepositoryFake } from '../../../application/testing/in-memory-template-repository.fake';
import { InMemoryTranscriberFake } from '../../../application/testing/in-memory-transcriber.fake';
import { AppInfoPort } from '../../../core/ports/app-info.port';
import { AudioImportPort } from '../../../core/ports/audio-import.port';
import { FileDialogPort } from '../../../core/ports/file-dialog.port';
import { MeetingRepositoryPort } from '../../../core/ports/meeting-repository.port';
import { ModelsStatusPort } from '../../../core/ports/models-status.port';
import { MeetingsError } from '../../../core/models/recording-state.model';
import { PreferencesPort } from '../../../core/ports/preferences.port';
import { RecorderPort } from '../../../core/ports/recorder.port';
import { SummarizerPort } from '../../../core/ports/summarizer.port';
import { TemplateRepositoryPort } from '../../../core/ports/template-repository.port';
import { TranscriberPort } from '../../../core/ports/transcriber.port';
import { provideMeetings } from '../../../meetings.providers';
import { MeetingsShellPage } from './meetings-shell.page';

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

/**
 * Higher-level regression pinning the FULL real path — facade -> store ->
 * template — not just component render logic. Uses `provideMeetings()` with
 * the project's in-memory fakes (same pattern as
 * `meetings.facade.import.spec.ts`), never a hand-rolled facade stub, so a
 * regression in the wiring between the facade and the template (like the
 * one this whole task fixes) cannot hide behind a stub that already assumes
 * the wiring works.
 */
describe('MeetingsShellPage import error visibility (regression)', () => {
  let fileDialog: InMemoryFileDialogFake;
  let audioImport: InMemoryAudioImportFake;
  let routeParamMap: BehaviorSubject<ParamMap>;

  beforeEach(() => {
    routeParamMap = new BehaviorSubject<ParamMap>(convertToParamMap({}));

    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { paramMap: routeParamMap } },
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
        { provide: AudioImportPort, useClass: InMemoryAudioImportFake },
      ],
    });

    fileDialog = TestBed.inject(FileDialogPort) as InMemoryFileDialogFake;
    audioImport = TestBed.inject(AudioImportPort) as InMemoryAudioImportFake;
  });

  it('surfaces a PATH import failure as a visible app-error-state even though no meeting was ever selected', async () => {
    fileDialog.seed('/Users/x/myna/meetings/m1/audio.wav');
    audioImport.seedError(
      new MeetingsError('PATH', 'source path is inside the meetings root and would be overwritten by the import'),
    );

    const fixture = TestBed.createComponent(MeetingsShellPage);
    fixture.detectChanges();
    await flushMicrotasks();
    fixture.detectChanges();

    fixture.componentInstance.onImportRequested();
    await flushMicrotasks();
    fixture.detectChanges();

    const facade = TestBed.inject(MeetingsFacade);
    expect(facade.selectedMeeting()).toBeUndefined();
    expect(facade.error()?.code).toBe('PATH');
    expect(fixture.nativeElement.querySelector('app-error-state')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('The selected file location is invalid.');
  });

  it('dismisses the error via the retry affordance when no meeting is selected (retry cannot reload nothing)', async () => {
    fileDialog.seed('/Users/x/myna/meetings/m1/audio.wav');
    audioImport.seedError(new MeetingsError('PATH', 'source path is inside the meetings root'));

    const fixture = TestBed.createComponent(MeetingsShellPage);
    fixture.detectChanges();
    await flushMicrotasks();
    fixture.detectChanges();

    fixture.componentInstance.onImportRequested();
    await flushMicrotasks();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-error-state')).toBeTruthy();

    fixture.nativeElement.querySelector('app-error-state .retry').click();
    fixture.detectChanges();

    const facade = TestBed.inject(MeetingsFacade);
    expect(facade.error()).toBeUndefined();
    expect(fixture.nativeElement.querySelector('app-error-state')).toBeNull();
  });
});
