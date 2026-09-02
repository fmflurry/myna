import type { ModelsStatus } from '../models/models-status.model';

/** Maps onto the frozen Rust command `models_status`. */
export abstract class ModelsStatusPort {
  abstract status(): Promise<ModelsStatus>;
}
