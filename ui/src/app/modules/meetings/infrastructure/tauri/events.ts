import type {
  ErrorPayloadDto,
  FinalPayloadDto,
  LevelPayloadDto,
  PartialPayloadDto,
  RecordingStatePayloadDto,
  SummaryDonePayloadDto,
  TokenPayloadDto,
} from '../dto/event-payload.dto';

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
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/** Ties each {@link EventName} to its exact payload DTO. */
export interface EventSignatures {
  readonly 'recording://state': RecordingStatePayloadDto;
  readonly 'recording://level': LevelPayloadDto;
  readonly 'transcript://partial': PartialPayloadDto;
  readonly 'transcript://final': FinalPayloadDto;
  readonly 'summary://token': TokenPayloadDto;
  readonly 'summary://done': SummaryDonePayloadDto;
  readonly 'error://occurred': ErrorPayloadDto;
}

export type EventPayload<E extends EventName> = EventSignatures[E];
