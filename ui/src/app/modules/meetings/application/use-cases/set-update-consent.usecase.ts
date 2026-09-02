import { Injectable, inject } from '@angular/core';

import type { UpdateConsent } from '../../core/models/update.model';
import { UpdatesPort } from '../../core/ports/updates.port';

@Injectable()
export class SetUpdateConsentUseCase {
  private readonly updates = inject(UpdatesPort);

  async set(consent: UpdateConsent): Promise<void> {
    await this.updates.setConsent(consent);
  }
}
