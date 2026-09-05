import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

import { MenuPort } from '../../core/ports/menu.port';

/**
 * In-memory MenuPort implementation for specs. Mirrors the Subject
 * pattern of `InMemoryUpdatesFake`'s install-event streams: the port
 * exposes the Subject as an Observable and {@link requestSettings}
 * stands in for a native "Settings…" menu click.
 */
@Injectable()
export class InMemoryMenuFake extends MenuPort {
  private readonly settingsRequestsSubject = new Subject<void>();

  override settingsRequests(): Observable<void> {
    return this.settingsRequestsSubject.asObservable();
  }

  /** Test helper: emit one synthetic settings request. */
  requestSettings(): void {
    this.settingsRequestsSubject.next();
  }
}
