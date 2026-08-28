export type RecordingState = 'idle' | 'recording' | 'stopping';

/**
 * Every error code the facade can surface: the application-level codes
 * thrown directly by use cases (`BUSY`, `NOT_RECORDING`, `NOT_FOUND`) plus
 * the full Rust `AppError` taxonomy relayed verbatim through the Tauri IPC
 * seam (see `app/src-tauri/src/error.rs`), plus `UNKNOWN` as a fallback for
 * anything that doesn't match either.
 */
export type MeetingsErrorCode =
  | 'BUSY'
  | 'NOT_RECORDING'
  | 'NOT_FOUND'
  | 'IO'
  | 'STORE'
  | 'STT'
  | 'LLM'
  | 'AUDIO'
  | 'MODELS_MISSING'
  | 'PATH'
  | 'UNKNOWN';

/**
 * Application-level error mirroring the Rust error envelope shape
 * `{ code: "SCREAMING_SNAKE", message: string }`.
 */
export class MeetingsError extends Error {
  readonly code: MeetingsErrorCode;

  constructor(code: MeetingsErrorCode, message: string) {
    super(message);
    this.name = 'MeetingsError';
    this.code = code;
  }
}
