/** Mirrors the Rust `myna_audio::DeviceInfo` (no rename attribute). */
export interface DeviceInfoDto {
  readonly name: string;
}

/** Mirrors the Rust `myna_audio::AudioSourceInfo` (no rename attribute). */
export interface AudioSourceDto {
  readonly id: string;
  readonly name: string;
}
