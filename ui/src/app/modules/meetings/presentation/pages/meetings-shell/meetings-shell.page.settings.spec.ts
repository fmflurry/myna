import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, type ParamMap } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { vi } from 'vitest';

import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import { InMemoryAppInfoFake } from '../../../application/testing/in-memory-app-info.fake';
import { InMemoryAudioImportFake } from '../../../application/testing/in-memory-audio-import.fake';
import { InMemoryFileDialogFake } from '../../../application/testing/in-memory-file-dialog.fake';
import { InMemoryMeetingRepositoryFake } from '../../../application/testing/in-memory-meeting-repository.fake';
import { InMemoryMenuFake } from '../../../application/testing/in-memory-menu.fake';
import { InMemoryModelsStatusFake } from '../../../application/testing/in-memory-models-status.fake';
import { InMemoryPreferencesFake } from '../../../application/testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../../../application/testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../../../application/testing/in-memory-summarizer.fake';
import { InMemoryTemplateRepositoryFake } from '../../../application/testing/in-memory-template-repository.fake';
import { InMemoryTranscriberFake } from '../../../application/testing/in-memory-transcriber.fake';
import { InMemoryUpdatesFake } from '../../../application/testing/in-memory-updates.fake';
import { AppInfoPort } from '../../../core/ports/app-info.port';
import { AudioImportPort } from '../../../core/ports/audio-import.port';
import { FileDialogPort } from '../../../core/ports/file-dialog.port';
import { MeetingRepositoryPort } from '../../../core/ports/meeting-repository.port';
import { MenuPort } from '../../../core/ports/menu.port';
import { ModelsStatusPort } from '../../../core/ports/models-status.port';
import { PreferencesPort } from '../../../core/ports/preferences.port';
import { RecorderPort } from '../../../core/ports/recorder.port';
import { SummarizerPort } from '../../../core/ports/summarizer.port';
import { TemplateRepositoryPort } from '../../../core/ports/template-repository.port';
import { TranscriberPort } from '../../../core/ports/transcriber.port';
import { UpdatesPort } from '../../../core/ports/updates.port';
import { flushMicrotasks } from '../../../infrastructure/tauri/testing/tauri-internals.stub';
import { provideMeetings } from '../../../meetings.providers';
import { MeetingsShellPage } from './meetings-shell.page';

/**
 * Settings-modal shell wiring at the real facade/store boundary (same
 * `provideMeetings()` + in-memory-port pattern as
 * `meetings-shell.page.import-error.spec.ts`, plus a `MenuPort` override so
 * a synthetic native "Settings…" menu click drives the same
 * `facade.settingsRequests()` stream the shipped app listens to). Pins the
 * gear trigger, menu-open, About/settings mutual exclusion, and the
 * backdrop close affordances.
 */
describe('MeetingsShellPage settings modal', () => {
  let menu: InMemoryMenuFake;
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
        { provide: UpdatesPort, useClass: InMemoryUpdatesFake },
        { provide: MenuPort, useClass: InMemoryMenuFake },
      ],
    });

    menu = TestBed.inject(MenuPort) as InMemoryMenuFake;
    // 'granted' keeps the first-run consent dialog out of the way — these
    // specs are about the settings modal, not consent gating.
    (TestBed.inject(UpdatesPort) as InMemoryUpdatesFake).seedConsent('granted');
  });

  const createFixture = async () => {
    const fixture = TestBed.createComponent(MeetingsShellPage);
    fixture.detectChanges();
    await flushMicrotasks();
    fixture.detectChanges();
    return fixture;
  };

  it('opens the settings modal from the title-bar gear trigger', async () => {
    const fixture = await createFixture();
    expect(fixture.nativeElement.querySelector('app-settings')).toBeNull();

    (fixture.nativeElement.querySelector('.settings-trigger') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-settings')).toBeTruthy();
  });

  it('a native menu settings request opens the modal and closes About (mutual exclusion)', async () => {
    const fixture = await createFixture();
    fixture.componentInstance.toggleAbout();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-attribution')).toBeTruthy();

    menu.requestSettings();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-settings')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('app-attribution')).toBeNull();
  });

  it('closes the modal when the backdrop itself is clicked', async () => {
    const fixture = await createFixture();
    (fixture.nativeElement.querySelector('.settings-trigger') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-settings')).toBeTruthy();

    (fixture.nativeElement.querySelector('.settings-backdrop') as HTMLElement).click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-settings')).toBeNull();
  });

  it('closes the modal on Escape while the backdrop has focus', async () => {
    const fixture = await createFixture();
    menu.requestSettings();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-settings')).toBeTruthy();

    fixture.nativeElement
      .querySelector('.settings-backdrop')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-settings')).toBeNull();
  });

  it('closes the modal on Escape from a bubbled inner-element keydown (modal-wide)', async () => {
    const fixture = await createFixture();
    menu.requestSettings();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-settings')).toBeTruthy();

    fixture.nativeElement
      .querySelector('.settings-backdrop .modal')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-settings')).toBeNull();
  });

  it('does NOT close on a Space keydown bubbled from an inner element (consent checkbox)', async () => {
    const fixture = await createFixture();
    menu.requestSettings();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-settings')).toBeTruthy();

    fixture.nativeElement
      .querySelector('.settings-backdrop .modal')
      .dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-settings')).toBeTruthy();
  });

  it('closes on Enter/Space when the backdrop itself is the keydown target', async () => {
    const fixture = await createFixture();
    menu.requestSettings();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-settings')).toBeTruthy();

    fixture.nativeElement
      .querySelector('.settings-backdrop')
      .dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-settings')).toBeNull();
  });

  it('clicking the gear while About is open closes About and opens Settings', async () => {
    const fixture = await createFixture();
    fixture.componentInstance.toggleAbout();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-attribution')).toBeTruthy();

    (fixture.nativeElement.querySelector('.settings-trigger') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-settings')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('app-attribution')).toBeNull();
  });

  it('opening About while Settings is open closes Settings (bidirectional exclusion)', async () => {
    const fixture = await createFixture();
    (fixture.nativeElement.querySelector('.settings-trigger') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-settings')).toBeTruthy();

    fixture.componentInstance.toggleAbout();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-attribution')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('app-settings')).toBeNull();
  });

  it('forwards the modal summary-language choice to the facade', async () => {
    const facade = TestBed.inject(MeetingsFacade);
    const selectLanguage = vi.spyOn(facade, 'selectSummaryLanguage');
    const fixture = await createFixture();
    menu.requestSettings();
    fixture.detectChanges();

    const select: HTMLSelectElement = fixture.nativeElement.querySelector('app-settings select');
    select.value = 'fr';
    select.dispatchEvent(new Event('change'));

    expect(selectLanguage).toHaveBeenCalledWith('fr');
  });
});
