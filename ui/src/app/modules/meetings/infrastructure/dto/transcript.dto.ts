/**
 * Wire shapes for transcript data crossing the Tauri IPC boundary.
 *
 * Two distinct segment shapes exist on the Rust side:
 * - {@link TranscriptSegmentDto} mirrors `myna_app::dto::TranscriptSegmentDto`
 *   (`#[serde(rename_all = "camelCase")]`), used inside {@link TranscriptDto}
 *   (returned by `get_transcript` and embedded in `MeetingDto`).
 * - {@link RawTranscriptSegmentDto} mirrors `myna_stt::TranscriptSegment`
 *   directly, which carries NO rename attribute and therefore serializes in
 *   snake_case. It appears only inside the `transcript://final` event
 *   payload (see `FinalPayload` in `app/src-tauri/src/events.rs`).
 */
export interface TranscriptSegmentDto {
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
}

/** Snake-case segment shape, unique to the `transcript://final` event. */
export interface RawTranscriptSegmentDto {
  readonly start_sec: number;
  readonly end_sec: number;
  readonly text: string;
}

/** Mirrors the Rust `TranscriptDto` (`#[serde(rename_all = "camelCase")]`). */
export interface TranscriptDto {
  readonly segments: readonly TranscriptSegmentDto[];
}
