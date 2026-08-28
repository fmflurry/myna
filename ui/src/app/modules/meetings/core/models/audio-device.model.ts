export interface AudioDevice {
  readonly name: string;
}

export interface AudioLevel {
  readonly rms: number;
  readonly dbfs: number;
}
