import type { ModelsStatus } from '../models/models-status.model';

/**
 * Maps onto the frozen Rust command `models_status`. Models always resolve
 * to `~/myna/models` (`MYNA_MODELS_DIR` only override) regardless of storage location.
 */
export abstract class ModelsStatusPort {
  abstract status(): Promise<ModelsStatus>;
}
