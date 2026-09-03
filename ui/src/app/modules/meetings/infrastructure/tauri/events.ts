import type {
  ErrorPayloadDto,
  FinalPayloadDto,
  LevelPayloadDto,
  PartialPayloadDto,
  RecordingStatePayloadDto,
  SummaryDonePayloadDto,
  TokenPayloadDto,
} from '../dto/event-payload.dto';
import type { ImportProgressPayloadDto } from '../dto/import.dto';
import type {
  ModelDownloadDone,
  ModelDownloadProgress,
} from '../../core/ports/model-initializer.port';
import type { UpdateInstallDone } from '../../core/ports/updates.port';

/**
 * The frozen Rust event surface (`app/src-tauri/src/events.rs`). Every
 * entry here must match a Rust event name exactly.
 */
export const EVENT_NAMES = [
  'recording://state',
  'recording://level',
  'transcript://partial',
  'transcript://final',
  'summary://token',
  'summary://done',
  'error://occurred',
  'import://progress',
  'models://progress',
  'models://done',
  'update://progress',
  'update://done',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/**
 * Raw `update://progress` wire payload — mirrors Rust `UpdateProgressPayload`
 * (`app/src-tauri/src/events.rs`) where `total_bytes` and `percent` are
 * `Option`, so the wire can carry `null` for both (no `Content-Length`
 * server-side). Normalization (`null` total → 0, percent pass-through) is
 * the adapter's job; the port's `UpdateInstallProgress` describes the
 * adapter OUTPUT, not this raw shape.
 */
export interface UpdateProgressWireDto {
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
  readonly percent: number | null;
}

/** Ties each {@link EventName} to its exact payload DTO. */
export interface EventSignatures {
  readonly 'recording://state': RecordingStatePayloadDto;
  readonly 'recording://level': LevelPayloadDto;
  readonly 'transcript://partial': PartialPayloadDto;
  readonly 'transcript://final': FinalPayloadDto;
  readonly 'summary://token': TokenPayloadDto;
  readonly 'summary://done': SummaryDonePayloadDto;
  readonly 'error://occurred': ErrorPayloadDto;
  readonly 'import://progress': ImportProgressPayloadDto;
  readonly 'models://progress': ModelDownloadProgress;
  readonly 'models://done': ModelDownloadDone;
  readonly 'update://progress': UpdateProgressWireDto;
  readonly 'update://done': UpdateInstallDone;
}

export type EventPayload<E extends EventName> = EventSignatures[E];
