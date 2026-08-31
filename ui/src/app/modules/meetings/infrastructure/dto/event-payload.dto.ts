import type { RecordingState } from '../../core/models/recording-state.model';
import type { AudioSourceDto } from './device.dto';
import type { RawTranscriptSegmentDto } from './transcript.dto';

/**
 * Payloads emitted by the Rust core on the webview event channel. Every
 * struct in `app/src-tauri/src/events.rs` is `#[serde(rename_all =
 * "camelCase")]`, EXCEPT the nested `segment` field of `FinalPayload`,
 * which embeds `myna_stt::TranscriptSegment` verbatim (snake_case) — see
 * {@link RawTranscriptSegmentDto}.
 */

/** Payload for the `recording://state` event. */
export interface RecordingStatePayloadDto {
  readonly meetingId: string | null;
  readonly state: RecordingState;
  /**
   * The system audio source ACTUALLY in effect (after any silent fallback),
   * or `null` when the current/last recording captures no system audio.
   */
  readonly effectiveSystemSource: AudioSourceDto | null;
}

/** Payload for the `recording://level` event. */
export interface LevelPayloadDto {
  readonly rms: number;
  readonly dbfs: number;
}

/** Payload for the `transcript://partial` event. */
export interface PartialPayloadDto {
  readonly meetingId: string;
  readonly text: string;
  readonly speaker: string;
}

/** Payload for the `transcript://final` event. */
export interface FinalPayloadDto {
  readonly meetingId: string;
  readonly segment: RawTranscriptSegmentDto;
}

/** Payload for the `error://occurred` event. */
export interface ErrorPayloadDto {
  readonly code: string;
  readonly message: string;
}

/** Payload for the `summary://token` event. */
export interface TokenPayloadDto {
  readonly meetingId: string;
  readonly template: string;
  readonly token: string;
}

/** Payload for the `summary://done` event. */
export interface SummaryDonePayloadDto {
  readonly meetingId: string;
  readonly template: string;
  readonly markdown: string;
  readonly language: string;
}
