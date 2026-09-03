import { Injectable, OnDestroy, inject } from '@angular/core';
import { Subscription } from 'rxjs';

import { MeetingsError, type MeetingsErrorCode } from '../../core/models/recording-state.model';
import type { UpdateConsent, UpdateInstallResult } from '../../core/models/update.model';
import { UpdatesPort } from '../../core/ports/updates.port';
import { CheckForUpdateUseCase } from '../use-cases/check-for-update.usecase';
import { GetUpdateConsentUseCase } from '../use-cases/get-update-consent.usecase';
import { SetUpdateConsentUseCase } from '../use-cases/set-update-consent.usecase';
import { UpdatesStore } from '../stores/updates.store';

/** Fallback failure text when the wire reports a failed install without a message. */
const INSTALL_FAILED_FALLBACK_MESSAGE = 'update install failed';

/**
 * The `message` Rust pairs with the up-to-date no-op terminal
 * `{success: true, version: null, message: 'up-to-date'}` — nothing was
 * installed, so the install machine must return to `'idle'`, never
 * `'ready'`.
 */
const UP_TO_DATE_MESSAGE = 'up-to-date';

/**
 * Update-check consent gating, banner dismissal, check-for-update
 * orchestration, and the one-click install state machine, split out of
 * `MeetingsFacade` to keep it under the project's max-lines limit.
 * Injected directly by `MeetingsFacade`, never by a component — see the
 * module's facade-pattern rule.
 *
 * The install machine runs `idle → downloading(percent) → ready(version)`
 * or `→ failed(message)`: `installUpdate()` flips to `'downloading'`,
 * subscribes to the port's `installProgress()` / `installDone()` streams
 * for the duration of the run, and awaits the `install()` promise. The
 * FIRST terminal (done event or the resolve value) wins; late arrivals are
 * ignored. Percent is monotonic (never decreases, clamped to 0..100). A
 * rejected `install()` degrades to `'failed'` instead of throwing — the
 * same never-throw contract as {@link checkForUpdate}. Event subscriptions
 * are torn down at the terminal state, on the next `installUpdate()`, on
 * every new check result, and in `ngOnDestroy`.
 */
@Injectable()
export class UpdatesFacade implements OnDestroy {
  private readonly store = inject(UpdatesStore);
  private readonly updates = inject(UpdatesPort);
  private readonly getUpdateConsentUseCase = inject(GetUpdateConsentUseCase);
  private readonly setUpdateConsentUseCase = inject(SetUpdateConsentUseCase);
  private readonly checkForUpdateUseCase = inject(CheckForUpdateUseCase);
  private installEvents: Subscription | undefined;

  readonly consent = this.store.consent;
  readonly lastCheck = this.store.lastCheck;
  readonly checking = this.store.checking;
  readonly dismissedVersion = this.store.dismissedVersion;
  readonly installState = this.store.installState;

  loadConsent = (): Promise<void> => this.applyConsent(() => this.getUpdateConsentUseCase.get());
  grantConsent = (): Promise<void> => this.setConsent('granted');
  declineConsent = (): Promise<void> => this.setConsent('declined');

  ngOnDestroy(): void {
    this.teardownInstallEvents();
  }

  /** Runs a check-for-update pass; a rejected IPC call degrades to a `'failed'` result instead of throwing, so a caller never has to guard this with try/catch. */
  async checkForUpdate(manual: boolean): Promise<void> {
    this.store.setChecking(true);
    try {
      this.store.setLastCheck(await this.checkForUpdateUseCase.check(manual));
    } catch (caught) {
      this.store.setLastCheck({ status: 'failed', message: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      this.store.setChecking(false);
    }
    // A new check result supersedes any install state from the previous version.
    this.teardownInstallEvents();
    this.store.setInstallState({ status: 'idle' });
  }

  /**
   * Starts the one-click install. Never throws: an `install()` rejection
   * lands `'failed'` with the error message. Re-invoking while a run is in
   * flight restarts the machine (the previous listeners are torn down).
   */
  async installUpdate(): Promise<void> {
    this.teardownInstallEvents();
    this.store.setInstallState({ status: 'downloading', percent: 0 });
    const events = new Subscription();
    this.installEvents = events;
    events.add(
      this.updates.installProgress().subscribe({
        next: (progress) => this.applyInstallPercent(progress.percent),
        error: (error: unknown) => console.error('[update] install progress stream failed', error),
      }),
    );
    events.add(
      this.updates.installDone().subscribe({
        next: (done) => this.applyInstallResult(done),
        error: (error: unknown) => console.error('[update] install done stream failed', error),
      }),
    );
    try {
      this.applyInstallResult(await this.updates.install());
    } catch (caught) {
      this.applyInstallFailure(
        caught instanceof Error ? caught.message : String(caught),
        caught instanceof MeetingsError ? caught.code : undefined,
      );
    } finally {
      this.teardownInstallEvents();
    }
  }

  /**
   * Restarts the app to apply a ready update. Forwards the `restart_app`
   * invoke; a rejection surfaces as the typed `MeetingsError` from the IPC
   * seam so the banner handler can decide what to show.
   */
  async restartApp(): Promise<void> {
    await this.updates.restart();
  }

  /** Dismisses the banner for the CURRENT available version; a no-op if no update is currently available. */
  dismissBanner(): void {
    const check = this.store.lastCheck();
    if (check?.status === 'available') {
      this.store.setDismissedVersion(check.version);
    }
  }

  /**
   * Applies a progress tick while (and only while) downloading. A `null`
   * percent (Rust's indeterminate signal — no `Content-Length`) stays
   * `null`; the monotonic guard compares numbers only and clamps to
   * 0..100. Non-finite numbers are dropped.
   */
  private applyInstallPercent(percent: number | null): void {
    const current = this.store.installState();
    if (current.status !== 'downloading') {
      return;
    }
    if (percent === null) {
      this.store.setInstallState({ status: 'downloading', percent: null });
      return;
    }
    if (!Number.isFinite(percent)) {
      return;
    }
    const floor = current.percent === null ? 0 : current.percent;
    this.store.setInstallState({ status: 'downloading', percent: Math.min(100, Math.max(floor, percent)) });
  }

  /** Lands the terminal state from the first result (done event or install() resolve) to arrive while downloading. */
  private applyInstallResult(result: UpdateInstallResult): void {
    if (this.store.installState().status !== 'downloading') {
      return;
    }
    if (result.success) {
      // The up-to-date no-op installed nothing — "ready" would lie ("
      // Installed, version unknown. Restart to apply."). Return to idle so
      // the banner hides.
      if (result.version === null && result.message === UP_TO_DATE_MESSAGE) {
        this.store.setInstallState({ status: 'idle' });
        return;
      }
      this.store.setInstallState({ status: 'ready', version: result.version ?? '' });
    } else {
      this.applyInstallFailure(result.message ?? INSTALL_FAILED_FALLBACK_MESSAGE);
    }
  }

  /**
   * Lands `'failed'` with a non-empty message, carrying the stable
   * {@link MeetingsErrorCode} when the rejection was a typed
   * `MeetingsError` (e.g. `'BUSY'` from the recording gate) so the banner
   * can switch on the code instead of sniffing the message.
   */
  private applyInstallFailure(message: string, code?: MeetingsErrorCode): void {
    if (this.store.installState().status !== 'downloading') {
      return;
    }
    const nonEmpty = message.length > 0 ? message : INSTALL_FAILED_FALLBACK_MESSAGE;
    this.store.setInstallState(
      code === undefined
        ? { status: 'failed', message: nonEmpty }
        : { status: 'failed', message: nonEmpty, code },
    );
  }

  private teardownInstallEvents(): void {
    this.installEvents?.unsubscribe();
    this.installEvents = undefined;
  }

  private async applyConsent(run: () => Promise<UpdateConsent>): Promise<void> {
    this.store.setConsent(await run());
  }

  /** Persists `consent` via the port THEN mirrors it into the store; never optimistic. */
  private async setConsent(consent: UpdateConsent): Promise<void> {
    await this.setUpdateConsentUseCase.set(consent);
    this.store.setConsent(consent);
  }
}
