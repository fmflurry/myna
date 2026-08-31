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
  readonly hasSystemTrack: boolean;
  readonly droppedAudioChunks: number;
  /**
   * The meeting's folder, or `null` when unfiled. Same `Option<T>`-as-
   * key-or-null modeling as `audioPath`/`transcript` on the wire; typed
   * optional here (rather than required) so DTO literals predating this
   * field (still exercised by existing specs) keep type-checking.
   */
  readonly folderId?: string | null;
  /**
   * Display names keyed by flat speaker label (e.g. `'others:1'` ->
   * `'Jean'`), mirroring Rust `MeetingDto::speaker_names`. The Rust side
   * always serializes the map (empty included); typed optional here for
   * the same pre-existing-fixture reason as `folderId`.
   */
  readonly speakerNames?: Readonly<Record<string, string>>;
}
