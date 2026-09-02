import { Injectable, inject, signal } from '@angular/core';
import type { Signal } from '@angular/core';

import type { UpdateCheck, UpdateConsent } from '../../core/models/update.model';
import { PreferencesPort } from '../../core/ports/preferences.port';

/** localStorage key the last-dismissed update-banner version is persisted under. */
export const DISMISSED_UPDATE_VERSION_PREFERENCE_KEY = 'meetings.dismissedUpdateVersion';

/** Reads the persisted dismissed-banner version; the empty-string sentinel (never dismissed) reads back as `null`. */
const readDismissedVersion = (preferences: PreferencesPort): string | null => {
  const stored = preferences.get(DISMISSED_UPDATE_VERSION_PREFERENCE_KEY);
  return stored === null || stored === '' ? null : stored;
};

/**
 * Holds updates-feature state: consent status, the latest check-for-update
 * result, whether a check is in flight, and the last-dismissed banner
 * version. A plain signal-backed store (unlike the flurryx-backed
 * `MeetingsStore`) since this feature needs no cross-navigation
 * replay/cache semantics. Registered only in `provideMeetings()` — NEVER
 * `providedIn: 'root'`; root scope can't see ports bound at the lazy route
 * injector (see the module's DI rule; that mistake yields `NG0201` and a
 * blank app).
 */
@Injectable()
export class UpdatesStore {
  private readonly preferences = inject(PreferencesPort);

  private readonly consentSignal = signal<UpdateConsent>('unset');
  private readonly lastCheckSignal = signal<UpdateCheck | undefined>(undefined);
  private readonly checkingSignal = signal<boolean>(false);
  private readonly dismissedVersionSignal = signal<string | null>(readDismissedVersion(this.preferences));

  readonly consent: Signal<UpdateConsent> = this.consentSignal.asReadonly();
  readonly lastCheck: Signal<UpdateCheck | undefined> = this.lastCheckSignal.asReadonly();
  readonly checking: Signal<boolean> = this.checkingSignal.asReadonly();
  readonly dismissedVersion: Signal<string | null> = this.dismissedVersionSignal.asReadonly();

  setConsent(consent: UpdateConsent): void {
    this.consentSignal.set(consent);
  }

  setLastCheck(check: UpdateCheck): void {
    this.lastCheckSignal.set(check);
  }

  setChecking(checking: boolean): void {
    this.checkingSignal.set(checking);
  }

  /** Persists (via `PreferencesPort`) and applies the dismissed-banner version; this is UI state, not the consent gate. */
  setDismissedVersion(version: string | null): void {
    this.preferences.set(DISMISSED_UPDATE_VERSION_PREFERENCE_KEY, version ?? '');
    this.dismissedVersionSignal.set(version);
  }
}
