import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, type ParamMap } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import type { UpdateCheck } from '../../../core/models/update.model';
import type { TauriInternalsStub } from '../../../infrastructure/tauri/testing/tauri-internals.stub';
import {
  flushMicrotasks,
  installTauriInternalsStub,
  uninstallTauriInternalsStub,
} from '../../../infrastructure/tauri/testing/tauri-internals.stub';
import { provideMeetings } from '../../../meetings.providers';
import { MeetingsShellPage } from './meetings-shell.page';

/**
 * Boot-path regression spec for the automatic launch-time update check, run
 * through the REAL injector graph — real `MeetingsFacade`, real
 * `UpdatesFacade`, real `TauriUpdatesAdapter`, real `UpdatesStore` (via
 * `provideMeetings()`). Only the outermost boundary
 * (`window.__TAURI_INTERNALS__`) is stubbed.
 *
 * This deliberately complements `meetings-shell.page.updates.spec.ts`, which
 * hand-stubs the whole `facade.updates` object: that spec proves the shell
 * CALLS the launch path, but only a real-facade spec catches the launch path
 * dying silently when the consent read rejects — the one way "consent is
 * granted" and "no check ever runs" coexist in the shipped app. Per the
 * project's Vitest law: no `fakeAsync`/`tick`, no `vi.mock()` hoisting —
 * stub the Tauri internals and drain with `flushMicrotasks()`.
 */
describe('MeetingsShellPage launch update check (real facade graph)', () => {
  /** Wire shape of `RecordingStatePayloadDto` — idle boot so `busy()` never gates the launch path. */
  const IDLE_STATE = { state: 'idle', meetingId: null, effectiveSystemSource: null, elapsedSec: null };

  /** Wire shape of `ModelsStatusDto` — present so no model-onboarding branch interferes. */
  const MODELS_READY = {
    parakeet: { present: true, path: '/models/parakeet', expectedFiles: [] },
    qwen: { present: true, path: '/models/qwen', expectedFiles: [] },
    silero: { present: true, path: '/models/silero', expectedFiles: [] },
    allPresent: true,
  };

  /** Wire shape of `UpdateCheckDto` (`status` kebab-case, rest camelCase). */
  const AVAILABLE_DTO = {
    status: 'available',
    version: '0.4.0',
    notes: 'Faster startup.',
    downloadUrl: 'https://github.com/fmflurry/myna/releases/download/v0.4.0/Myna.app.tar.gz',
  };

  const expectedAvailable: UpdateCheck = {
    status: 'available',
    version: '0.4.0',
    notes: 'Faster startup.',
    downloadUrl: 'https://github.com/fmflurry/myna/releases/download/v0.4.0/Myna.app.tar.gz',
  };

  let tauri: TauriInternalsStub;

  /** Installs the IPC stub with the given launch-time consent value; an `Error` makes `update_consent` reject. */
  const stubIpc = (consent: 'unset' | 'granted' | 'declined' | Error) => {
    tauri = installTauriInternalsStub((cmd) => {
      if (cmd === 'update_consent') {
        if (consent instanceof Error) {
          throw consent;
        }
        return consent;
      }
      if (cmd === 'check_for_update') {
        return AVAILABLE_DTO;
      }
      if (cmd === 'recording_state') {
        return IDLE_STATE;
      }
      if (cmd === 'list_meetings') {
        return [];
      }
      if (cmd === 'models_status') {
        return MODELS_READY;
      }
      return null;
    });
  };

  /** Every `check_for_update` invoke the launch path issued, in call order. */
  const checkInvocations = (stub: TauriInternalsStub): readonly unknown[][] =>
    stub.invokeSpy.mock.calls.filter((call) => call[0] === 'check_for_update');

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideMeetings(),
        {
          provide: ActivatedRoute,
          useValue: { paramMap: new BehaviorSubject<ParamMap>(convertToParamMap({})) },
        },
      ],
    });
  });

  afterEach(() => {
    uninstallTauriInternalsStub();
    vi.restoreAllMocks();
  });

  const createFixture = async () => {
    const fixture = TestBed.createComponent(MeetingsShellPage);
    // detectChanges runs ngOnInit, which fires the launch path.
    fixture.detectChanges();
    await flushMicrotasks();
    fixture.detectChanges();
    return fixture;
  };

  it('runs exactly one non-manual update check on launch when consent is granted', async () => {
    stubIpc('granted');

    const fixture = await createFixture();
    const facade = TestBed.inject(MeetingsFacade);

    const calls = checkInvocations(tauri);
    expect(calls.length).toBe(1);
    expect(calls[0]?.[1]).toEqual({ manual: false });
    // The found update surfaces through the existing store → banner state path.
    expect(facade.updates.lastCheck()).toEqual(expectedAvailable);
    expect(fixture.nativeElement.querySelector('app-update-banner .update-banner')).toBeTruthy();
  });

  it('runs no update check on launch when consent is declined', async () => {
    stubIpc('declined');

    await createFixture();

    expect(checkInvocations(tauri)).toEqual([]);
  });

  it('runs no update check on launch when consent is unset', async () => {
    stubIpc('unset');

    await createFixture();

    expect(checkInvocations(tauri)).toEqual([]);
  });

  it('logs a failed launch consent read instead of swallowing it, and still never checks', async () => {
    // The consent model forbids checking on an UNCONFIRMED read — but the old
    // `void loadUpdatesOnLaunch(...)` call site dropped the rejection with
    // zero diagnostics, so a transient `update_consent` IPC failure made the
    // launch check vanish without a trace. The failure must be observable.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubIpc(new Error('consent read failed at boot'));

    await createFixture();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[update] launch consent read failed'),
      expect.anything(),
    );
    expect(checkInvocations(tauri)).toEqual([]);
  });
});
