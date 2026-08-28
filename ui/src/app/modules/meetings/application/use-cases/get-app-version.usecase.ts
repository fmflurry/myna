import { Injectable, inject } from '@angular/core';

import { AppInfoPort } from '../../core/ports/app-info.port';

/** Maps onto the frozen Rust command app_version. */
@Injectable()
export class GetAppVersionUseCase {
  private readonly appInfo = inject(AppInfoPort);

  async version(): Promise<string> {
    return this.appInfo.version();
  }
}
