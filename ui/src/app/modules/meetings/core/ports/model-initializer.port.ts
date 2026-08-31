import type { Observable } from 'rxjs';

/**
 * Progress event for one artifact's download, emitted on `models://progress`
 * BEFORE that artifact starts downloading. `index` is the zero-based
 * position of `artifact` in the run's artifact list; `total` is the size of
 * that list. Mirrors `ModelsProgressPayloadDto`.
 */
export interface ModelDownloadProgress {
  /** Script selector of the artifact about to download (`parakeet` | `qwen` | `vad`). */
  readonly artifact: string;
  readonly index: number;
  readonly total: number;
}

/**
 * Terminal event of a model-download run, emitted on `models://done`.
 * Mirrors `ModelsDonePayloadDto`.
 */
export interface ModelDownloadDone {
  /** Whether the models root now holds every required artifact. */
  readonly success: boolean;
  /** Whether the run ended because the user cancelled it (implies `success === false`). */
  readonly cancelled: boolean;
  /** Human-readable failure description; `null` on success and on cancellation. */
  readonly message: string | null;
}

/**
 * Maps onto the frozen Rust commands start_model_download and
 * cancel_model_download, plus the `models://progress` / `models://done`
 * events. `start()` resolves as soon as the backend run is spawned (or
 * no-ops successfully when everything is already present) — per-artifact
 * progress and the terminal outcome arrive exclusively via the events.
 */
export abstract class ModelInitializerPort {
  abstract start(): Promise<void>;
  abstract startDiarization(): Promise<void>;
  abstract cancel(): Promise<void>;
  abstract progress(): Observable<ModelDownloadProgress>;
  abstract done(): Observable<ModelDownloadDone>;
}
