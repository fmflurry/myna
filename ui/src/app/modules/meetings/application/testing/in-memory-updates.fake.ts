import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

import type {
  UpdateCheck,
  UpdateConsent,
  UpdateInstallResult,
} from '../../core/models/update.model';
import type { UpdateInstallDone, UpdateInstallProgress } from '../../core/ports/updates.port';
import { UpdatesPort } from '../../core/ports/updates.port';

/**
 * In-memory UpdatesPort implementation for specs and the placeholder
 * providers. Records every `check()` call's `manual` argument into
 * {@link checkCalls} so specs can assert call counts (e.g. throttling
 * behavior) without spying on a real IPC boundary. The install event
 * streams mirror `InMemoryAudioImportFake`'s Subject pattern.
 */
@Injectable()
export class InMemoryUpdatesFake extends UpdatesPort {
  /** Every `check()` call's `manual` argument, in call order. */
  readonly checkCalls: boolean[] = [];
  /** How many times `install()` has been called. */
  installCalls = 0;
  /** How many times `restart()` has been called. */
  restartCalls = 0;

  /** Reassignable: a fresh Subject replaces the errored one so re-subscription can succeed. */
  private installProgressSubject = new Subject<UpdateInstallProgress>();
  /** Reassignable: see {@link installProgressSubject}. */
  private installDoneSubject = new Subject<UpdateInstallDone>();

  private consentValue: UpdateConsent = 'unset';
  private checkResult: UpdateCheck = { status: 'up-to-date' };
  private installResult: UpdateInstallResult = { success: true, version: '9.9.9', message: null };
  private installError: Error | undefined;

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

  override async install(): Promise<UpdateInstallResult> {
    this.installCalls += 1;
    if (this.installError) {
      throw this.installError;
    }
    return this.installResult;
  }

  override async restart(): Promise<void> {
    this.restartCalls += 1;
  }

  override installProgress(): Observable<UpdateInstallProgress> {
    return this.installProgressSubject.asObservable();
  }

  override installDone(): Observable<UpdateInstallDone> {
    return this.installDoneSubject.asObservable();
  }

  /** Test helper: replace the in-memory consent value. */
  seedConsent(consent: UpdateConsent): void {
    this.consentValue = consent;
  }

  /** Test helper: replace the in-memory check() result. */
  seedCheckResult(result: UpdateCheck): void {
    this.checkResult = result;
  }

  /** Test helper: replace the in-memory install() result. */
  seedInstallResult(result: UpdateInstallResult): void {
    this.installResult = result;
  }

  /** Test helper: make install() reject with the given error. */
  seedInstallError(error: Error): void {
    this.installError = error;
  }

  /** Test helper: push a synthetic `update://progress` payload. */
  emitInstallProgress(progress: UpdateInstallProgress): void {
    this.installProgressSubject.next(progress);
  }

  /** Test helper: push a synthetic `update://done` payload. */
  emitInstallDone(done: UpdateInstallDone): void {
    this.installDoneSubject.next(done);
  }
}
