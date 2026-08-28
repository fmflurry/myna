import type { ImportPhase } from '../../core/ports/audio-import.port';

/**
 * Payload for the `import://progress` event
 * (`#[serde(rename_all = "camelCase")]` on the Rust side).
 */
export interface ImportProgressPayloadDto {
  readonly meetingId: string;
  readonly phase: ImportPhase;
  readonly processedSec: number;
  readonly totalSec: number;
}
