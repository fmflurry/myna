import { Injectable, inject } from '@angular/core';

import type { UpdateCheck } from '../../core/models/update.model';
import { UpdatesPort } from '../../core/ports/updates.port';

@Injectable()
export class CheckForUpdateUseCase {
  private readonly updates = inject(UpdatesPort);

  async check(manual: boolean): Promise<UpdateCheck> {
    return this.updates.check(manual);
  }
}
