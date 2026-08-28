import { Injectable } from '@angular/core';

import { AppInfoPort } from '../../core/ports/app-info.port';

const DEFAULT_VERSION = '0.0.0-dev';

/** In-memory AppInfoPort implementation for specs and the placeholder providers. */
@Injectable()
export class InMemoryAppInfoFake extends AppInfoPort {
  private appVersion: string = DEFAULT_VERSION;

  override async version(): Promise<string> {
    return this.appVersion;
  }

  /** Test helper: replace the in-memory app version. */
  seedVersion(version: string): void {
    this.appVersion = version;
  }
}
