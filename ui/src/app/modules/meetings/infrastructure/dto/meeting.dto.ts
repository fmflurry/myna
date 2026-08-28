import type { SummaryRefDto } from './summary.dto';
import type { TranscriptDto } from './transcript.dto';

/**
 * Mirrors the Rust `MeetingDto` (`#[serde(rename_all = "camelCase")]`).
 *
 * `audioPath` and `transcript` are Rust `Option<T>` fields with no
 * `skip_serializing_if`, so they always serialize as a key — either the
 * value or `null` — never omitted. Modeled as `T | null`, not `T | undefined`.
 */
export interface MeetingDto {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly durationSec: number;
  readonly audioPath: string | null;
  readonly transcript: TranscriptDto | null;
  readonly summaries: readonly SummaryRefDto[];
  readonly archived: boolean;
  readonly hasAudio: boolean;
}
