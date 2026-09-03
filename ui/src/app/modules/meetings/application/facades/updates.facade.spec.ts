import { TestBed } from '@angular/core/testing';

import type { UpdateInstallState } from '../../core/models/update.model';
import { MeetingsError } from '../../core/models/recording-state.model';
import { PreferencesPort } from '../../core/ports/preferences.port';
import { UpdatesPort } from '../../core/ports/updates.port';
import { CheckForUpdateUseCase } from '../use-cases/check-for-update.usecase';
import { GetUpdateConsentUseCase } from '../use-cases/get-update-consent.usecase';
import { SetUpdateConsentUseCase } from '../use-cases/set-update-consent.usecase';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { InMemoryUpdatesFake } from '../testing/in-memory-updates.fake';
import { UpdatesStore } from '../stores/updates.store';
import { UpdatesFacade } from './updates.facade';

/**
 * Spec for the one-click install state machine on `UpdatesFacade`. Drives
 * the install event streams through `InMemoryUpdatesFake` (the repo's
 * established fake-with-Subjects pattern — see `InMemoryAudioImportFake`);
 * no `vi.mock()` hoisting, no `fakeAsync`/`tick` per the project's Vitest
 * law.
 */
function setup(): { facade: UpdatesFacade; updates: InMemoryUpdatesFake } {
  TestBed.configureTestingModule({
    providers: [
      UpdatesFacade,
      UpdatesStore,
      CheckForUpdateUseCase,
      GetUpdateConsentUseCase,
      SetUpdateConsentUseCase,
      { provide: UpdatesPort, useClass: InMemoryUpdatesFake },
      { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
    ],
  });
  return {
    facade: TestBed.inject(UpdatesFacade),
    updates: TestBed.inject(UpdatesPort) as InMemoryUpdatesFake,
  };
}

describe('UpdatesFacade install state machine', () => {
  it('starts idle', () => {
    const { facade } = setup();
    expect(facade.installState()).toEqual({ status: 'idle' });
  });

  it('drives idle → downloading (monotonic 0 → 100) → ready from install events', async () => {
    const { facade, updates } = setup();
    expect(facade.installState()).toEqual({ status: 'idle' });

    const pending = facade.installUpdate();
    expect(facade.installState()).toEqual({ status: 'downloading', percent: 0 });

    updates.emitInstallProgress({ downloadedBytes: 40, totalBytes: 100, percent: 40 });
    expect(facade.installState()).toEqual({ status: 'downloading', percent: 40 });

    // A regressing percent must never decrease the displayed value.
    updates.emitInstallProgress({ downloadedBytes: 10, totalBytes: 100, percent: 10 });
    expect(facade.installState()).toEqual({ status: 'downloading', percent: 40 });

    // Out-of-range percents clamp to 100.
    updates.emitInstallProgress({ downloadedBytes: 150, totalBytes: 100, percent: 150 });
    expect(facade.installState()).toEqual({ status: 'downloading', percent: 100 });

    updates.emitInstallDone({ success: true, version: '2.0.0', message: null });
    expect(facade.installState()).toEqual({ status: 'ready', version: '2.0.0' });

    // The install() promise resolving afterwards must not overwrite the terminal state.
    await pending;
    expect(facade.installState()).toEqual({ status: 'ready', version: '2.0.0' });
  });

  it('lands ready(version) when install() resolves success without any events', async () => {
    const { facade, updates } = setup();
    updates.seedInstallResult({ success: true, version: '3.1.4', message: null });

    await facade.installUpdate();

    expect(facade.installState()).toEqual({ status: 'ready', version: '3.1.4' });
  });

  it('lands failed(message) when install() rejects, and never throws', async () => {
    const { facade, updates } = setup();
    updates.seedInstallError(new Error('boom'));

    await expectAsyncSafe(facade.installUpdate());

    expect(facade.installState()).toEqual({ status: 'failed', message: 'boom' });
  });

  it('carries the typed BUSY code on the failed state when install() rejects with MeetingsError', async () => {
    // FIX 5: MeetingsError.code survives the IPC seam; the failed state
    // must keep it as the stable sentinel so the banner never relies on
    // message-sniffing alone.
    const { facade, updates } = setup();
    updates.seedInstallError(
      new MeetingsError('BUSY', 'cannot install an update while a recording is in progress'),
    );

    await expectAsyncSafe(facade.installUpdate());

    const state = facade.installState();
    expect(state.status).toBe('failed');
    if (state.status === 'failed') {
      expect(state.code).toBe('BUSY');
    }
  });

  it('drops a non-BUSY MeetingsError code from the failed state only when absent', async () => {
    const { facade, updates } = setup();
    updates.seedInstallError(new MeetingsError('UPDATER', 'update check failed: 404'));

    await expectAsyncSafe(facade.installUpdate());

    expect(facade.installState()).toEqual({ status: 'failed', message: 'update check failed: 404', code: 'UPDATER' });
  });

  it('returns to idle (not ready) when install() resolves the up-to-date no-op terminal', async () => {
    // FIX 2: Rust sends {success:true, version:null, message:'up-to-date'}
    // for the no-op. Rendering that as "Installed, version unknown.
    // Restart to apply." is a lie — nothing was installed.
    const { facade, updates } = setup();
    updates.seedInstallResult({ success: true, version: null, message: 'up-to-date' });

    await facade.installUpdate();

    expect(facade.installState()).toEqual({ status: 'idle' });
  });

  it('returns to idle when the up-to-date no-op arrives as a done event', async () => {
    const { facade, updates } = setup();
    const pending = facade.installUpdate();

    updates.emitInstallDone({ success: true, version: null, message: 'up-to-date' });
    expect(facade.installState()).toEqual({ status: 'idle' });

    await pending;
  });

  it('keeps percent indeterminate (null) when progress arrives with percent: null', async () => {
    // FIX 3: Rust sends percent:null when Content-Length is absent — the
    // facade must never fabricate 0.
    const { facade, updates } = setup();
    const pending = facade.installUpdate();

    updates.emitInstallProgress({ downloadedBytes: 4096, totalBytes: 0, percent: null });
    expect(facade.installState()).toEqual({ status: 'downloading', percent: null });

    // A real number afterwards still lands (no monotonic comparison
    // against a null baseline).
    updates.emitInstallProgress({ downloadedBytes: 4096, totalBytes: 0, percent: 37.5 });
    expect(facade.installState()).toEqual({ status: 'downloading', percent: 37.5 });

    // Monotonic guard keeps working over numbers only.
    updates.emitInstallProgress({ downloadedBytes: 4096, totalBytes: 0, percent: 10 });
    expect(facade.installState()).toEqual({ status: 'downloading', percent: 37.5 });

    await pending;
  });

  it('lands failed(message) when install() resolves a failure result', async () => {
    const { facade, updates } = setup();
    updates.seedInstallResult({ success: false, version: null, message: 'no space left on device' });

    await facade.installUpdate();

    expect(facade.installState()).toEqual({ status: 'failed', message: 'no space left on device' });
  });

  it('lands failed(message) from a failed done event', async () => {
    const { facade, updates } = setup();
    const pending = facade.installUpdate();

    updates.emitInstallDone({ success: false, version: null, message: 'checksum mismatch' });
    expect(facade.installState()).toEqual({ status: 'failed', message: 'checksum mismatch' });

    await pending;
  });

  it('lands failed with a non-empty fallback message when the done event carries none', async () => {
    const { facade, updates } = setup();
    const pending = facade.installUpdate();

    updates.emitInstallDone({ success: false, version: null, message: null });
    const state = facade.installState();
    expect(state.status).toBe('failed');
    if (state.status === 'failed') {
      expect(state.message).toBeTruthy();
    }

    await pending;
  });

  it('ignores late events after the terminal state is reached', async () => {
    const { facade, updates } = setup();
    updates.seedInstallResult({ success: true, version: '2.0.0', message: null });

    await facade.installUpdate();
    updates.emitInstallProgress({ downloadedBytes: 50, totalBytes: 100, percent: 50 });
    updates.emitInstallDone({ success: false, version: null, message: 'late' });

    expect(facade.installState()).toEqual({ status: 'ready', version: '2.0.0' });
  });

  it('resets installState to idle when a new check result lands', async () => {
    const { facade, updates } = setup();
    updates.seedInstallResult({ success: true, version: '2.0.0', message: null });
    await facade.installUpdate();
    expect(facade.installState().status).toBe('ready');

    await facade.checkForUpdate(true);

    expect(facade.installState()).toEqual({ status: 'idle' });
  });

  it('restartApp() forwards to the port', async () => {
    const { facade, updates } = setup();

    await facade.restartApp();

    expect(updates.restartCalls).toBe(1);
  });

  it('exposes the install state as a read-only union member', () => {
    const { facade } = setup();
    const state: UpdateInstallState = facade.installState();
    expect(state.status).toBe('idle');
  });
});

/** Awaits the promise and fails the spec if it rejects — the never-throws contract. */
async function expectAsyncSafe(promise: Promise<void>): Promise<void> {
  await promise.then(
    () => undefined,
    (error: unknown) => {
      throw new Error(`installUpdate() must never throw, rejected with: ${String(error)}`);
    },
  );
}
