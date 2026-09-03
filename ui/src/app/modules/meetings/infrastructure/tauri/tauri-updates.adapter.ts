import { Injectable } from '@angular/core';
import { map } from 'rxjs';
import type { Observable } from 'rxjs';

import type { UpdateCheck, UpdateConsent, UpdateInstallResult } from '../../core/models/update.model';
import type { UpdateInstallDone, UpdateInstallProgress } from '../../core/ports/updates.port';
import { UpdatesPort } from '../../core/ports/updates.port';
import type { UpdateCheckDto } from '../dto/update.dto';
import type { UpdateInstallResultDto } from './commands';
import type { UpdateProgressWireDto } from './events';
import { invokeCommand, onEvent } from './ipc';

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

/** Coerces a possibly-garbage wire value to a finite number, else `undefined`. */
const toFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Maps the `install_update` resolve DTO onto the domain
 * {@link UpdateInstallResult}. Field-level guards (rather than blind
 * passthrough) keep a lying or truncated wire shape from poisoning the
 * facade state machine — same defensive posture as
 * {@link mapUpdateCheckDtoToDomain}.
 */
function mapUpdateInstallDtoToDomain(dto: UpdateInstallResultDto): UpdateInstallResult {
  return {
    success: dto.success === true,
    version: typeof dto.version === 'string' ? dto.version : null,
    message: typeof dto.message === 'string' ? dto.message : null,
  };
}

/**
 * Normalizes the raw `update://progress` wire payload into the port's
 * domain {@link UpdateInstallProgress} (adapter output — the wire shape
 * itself is `UpdateProgressWireDto`): byte counters floor at 0 (`null`
 * total → 0), a numeric `percent` is clamped to 0..100, and an
 * indeterminate one (`null` — Rust sends it whenever the server omitted
 * `Content-Length`) passes through as `null`, never coerced to a
 * fabricated 0. A missing / non-numeric percent degrades to the byte
 * ratio when `totalBytes > 0`, and to `null` (indeterminate) otherwise.
 */
function mapInstallProgressDtoToDomain(dto: UpdateProgressWireDto): UpdateInstallProgress {
  const downloadedBytes = Math.max(0, toFiniteNumber(dto.downloadedBytes) ?? 0);
  const totalBytes = Math.max(0, toFiniteNumber(dto.totalBytes) ?? 0);
  const percent =
    dto.percent === null
      ? null
      : toFiniteNumber(dto.percent) ?? (totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : null);
  return { downloadedBytes, totalBytes, percent: percent === null ? null : Math.min(100, Math.max(0, percent)) };
}

/** Normalizes an `update://done` payload; unknown shapes degrade to a safe failure. */
function mapInstallDoneDtoToDomain(dto: UpdateInstallDone): UpdateInstallDone {
  return {
    success: dto.success === true,
    version: typeof dto.version === 'string' ? dto.version : null,
    message: typeof dto.message === 'string' ? dto.message : null,
  };
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

  override async install(): Promise<UpdateInstallResult> {
    const dto = await invokeCommand('install_update', {});
    return mapUpdateInstallDtoToDomain(dto);
  }

  override async restart(): Promise<void> {
    await invokeCommand('restart_app', {});
  }

  override installProgress(): Observable<UpdateInstallProgress> {
    return onEvent('update://progress').pipe(map(mapInstallProgressDtoToDomain));
  }

  override installDone(): Observable<UpdateInstallDone> {
    return onEvent('update://done').pipe(map(mapInstallDoneDtoToDomain));
  }
}
