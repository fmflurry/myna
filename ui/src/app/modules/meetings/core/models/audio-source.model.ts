/**
 * One capturable system-audio source: either the all-output source
 * (`system:all`) or a single running application (`app:<bundle-id>` /
 * `app:pid:<pid>`). Mirrors the Rust `myna_audio::AudioSourceInfo`
 * (`app/src-tauri/src/lib.rs` `list_audio_sources` command).
 */
export interface AudioSource {
  readonly id: string;
  readonly name: string;
}

/** The id of the always-first "all system output" source. */
export const ALL_SYSTEM_AUDIO_SOURCE_ID = 'system:all';
