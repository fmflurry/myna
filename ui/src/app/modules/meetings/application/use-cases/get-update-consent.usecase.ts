import { Injectable, inject } from '@angular/core';

import type { UpdateConsent } from '../../core/models/update.model';
import { UpdatesPort } from '../../core/ports/updates.port';

@Injectable()
export class GetUpdateConsentUseCase {
  private readonly updates = inject(UpdatesPort);

  async get(): Promise<UpdateConsent> {
    return this.updates.consent();
  }
}
