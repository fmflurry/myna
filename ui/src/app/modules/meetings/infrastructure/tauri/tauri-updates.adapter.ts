import { Injectable } from '@angular/core';

import type { UpdateCheck, UpdateConsent } from '../../core/models/update.model';
import { UpdatesPort } from '../../core/ports/updates.port';
import type { UpdateCheckDto } from '../dto/update.dto';
import { invokeCommand } from './ipc';

/**
 * Maps a `UpdateCheckDto` onto the domain `UpdateCheck` union. An
 * unrecognized `status` (a forward-compatibility hazard across an IPC
 * boundary that isn't statically enforced at runtime) degrades to
 * `'failed'` rather than throwing, so a backend ahead of the UI never
 * crashes the update flow.
 */
function mapUpdateCheckDtoToDomain(dto: UpdateCheckDto): UpdateCheck {
  switch (dto.status) {
    case 'up-to-date':
      return { status: 'up-to-date' };
    case 'available':
      return {
        status: 'available',
        version: dto.version ?? '',
        notes: dto.notes ?? '',
        downloadUrl: dto.downloadUrl ?? '',
      };
    case 'skipped':
      return { status: 'skipped', reason: dto.reason ?? 'no-consent' };
    case 'failed':
      return { status: 'failed', message: dto.message ?? '' };
    default:
      return { status: 'failed', message: `unrecognized update check status: ${String(dto.status)}` };
  }
}

/** `UpdatesPort` implementation backed by the Tauri IPC command surface. */
@Injectable()
export class TauriUpdatesAdapter extends UpdatesPort {
  override async consent(): Promise<UpdateConsent> {
    return invokeCommand('update_consent', {});
  }

  override async setConsent(consent: UpdateConsent): Promise<void> {
    await invokeCommand('set_update_consent', { consent });
  }

  override async check(manual: boolean): Promise<UpdateCheck> {
    const dto = await invokeCommand('check_for_update', { manual });
    return mapUpdateCheckDtoToDomain(dto);
  }
}
