import { Injectable } from '@angular/core';

import type { UpdateCheck, UpdateConsent } from '../../core/models/update.model';
import { UpdatesPort } from '../../core/ports/updates.port';

/**
 * In-memory UpdatesPort implementation for specs and the placeholder
 * providers. Records every `check()` call's `manual` argument into
 * {@link checkCalls} so specs can assert call counts (e.g. throttling
 * behavior) without spying on a real IPC boundary.
 */
@Injectable()
export class InMemoryUpdatesFake extends UpdatesPort {
  /** Every `check()` call's `manual` argument, in call order. */
  readonly checkCalls: boolean[] = [];

  private consentValue: UpdateConsent = 'unset';
  private checkResult: UpdateCheck = { status: 'up-to-date' };

  override async consent(): Promise<UpdateConsent> {
    return this.consentValue;
  }

  override async setConsent(consent: UpdateConsent): Promise<void> {
    this.consentValue = consent;
  }

  override async check(manual: boolean): Promise<UpdateCheck> {
    this.checkCalls.push(manual);
    return this.checkResult;
  }

  /** Test helper: replace the in-memory consent value. */
  seedConsent(consent: UpdateConsent): void {
    this.consentValue = consent;
  }

  /** Test helper: replace the in-memory check() result. */
  seedCheckResult(result: UpdateCheck): void {
    this.checkResult = result;
  }
}
