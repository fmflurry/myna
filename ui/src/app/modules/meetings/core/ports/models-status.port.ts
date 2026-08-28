import type { ModelsStatus } from '../models/models-status.model';

/** Maps onto the frozen Rust commands models_status and download_command. */
export abstract class ModelsStatusPort {
  abstract status(): Promise<ModelsStatus>;
  abstract downloadCommand(): Promise<string>;
}
