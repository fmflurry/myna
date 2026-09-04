/**
 * The stop-phase / recording-health contract (ADR 0011 follow-through):
 * `stop_recording` and `cancel_recording` resolve with an acknowledgement the
 * moment the command is accepted — the finalized meeting never rides the
 * command result, it arrives on the `recording://completed` event. The UI
 * parks on `'stopping'` until then, rendering progress from the
 * `recording://stop-progress` phases below and surfacing `recording://health`
 * events as they land.
 */

/** Phases emitted on `recording://stop-progress` while a stop/cancel drains. */
export type StopPhase =
  | 'stopping-capture'
  | 'finalizing-transcript'
  | 'saving'
  | 'discarding'
  | 'recovering'
  | 'completed'
  | 'failed';

/** Which recording durability concern a `recording://health` event reports on. */
export type RecordingHealthCategory = 'wav-write' | 'journal' | 'decode-drop' | 'tap-rebuild' | 'disk';

/** Escalation level of a health event; drives ARIA live semantics in the UI. */
export type RecordingHealthSeverity = 'warning' | 'error' | 'fatal';

/** Payload of the `recording://health` event — the latest issue seen mid-recording. */
export interface RecordingHealthEvent {
  readonly category: RecordingHealthCategory;
  readonly severity: RecordingHealthSeverity;
  readonly message: string;
}

/**
 * Acknowledgement `cancel_recording` resolves with: the command was accepted
 * and the discard runs on the backend. `stop_recording` carries the same
 * payload on the wire; its port signature stays `Promise<Meeting>` for
 * legacy-spec compatibility, and the value is never consumed (the durable
 * row arrives via `recording://completed`).
 */
export interface StopAcknowledgement {
  readonly accepted: true;
}
