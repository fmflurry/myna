import { Injectable, inject } from '@angular/core';

import type { UpdateConsent } from '../../core/models/update.model';
import { CheckForUpdateUseCase } from '../use-cases/check-for-update.usecase';
import { GetUpdateConsentUseCase } from '../use-cases/get-update-consent.usecase';
import { SetUpdateConsentUseCase } from '../use-cases/set-update-consent.usecase';
import { UpdatesStore } from '../stores/updates.store';

/**
 * Update-check consent gating, banner dismissal, and check-for-update
 * orchestration, split out of `MeetingsFacade` to keep it under the
 * project's max-lines limit. Injected directly by `MeetingsFacade`, never
 * by a component — see the module's facade-pattern rule.
 */
@Injectable()
export class UpdatesFacade {
  private readonly store = inject(UpdatesStore);
  private readonly getUpdateConsentUseCase = inject(GetUpdateConsentUseCase);
  private readonly setUpdateConsentUseCase = inject(SetUpdateConsentUseCase);
  private readonly checkForUpdateUseCase = inject(CheckForUpdateUseCase);

  readonly consent = this.store.consent;
  readonly lastCheck = this.store.lastCheck;
  readonly checking = this.store.checking;
  readonly dismissedVersion = this.store.dismissedVersion;

  loadConsent = (): Promise<void> => this.applyConsent(() => this.getUpdateConsentUseCase.get());
  grantConsent = (): Promise<void> => this.setConsent('granted');
  declineConsent = (): Promise<void> => this.setConsent('declined');

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
  }

  /** Dismisses the banner for the CURRENT available version; a no-op if no update is currently available. */
  dismissBanner(): void {
    const check = this.store.lastCheck();
    if (check?.status === 'available') {
      this.store.setDismissedVersion(check.version);
    }
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
