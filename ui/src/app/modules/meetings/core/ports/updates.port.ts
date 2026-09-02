import type { UpdateCheck, UpdateConsent } from '../models/update.model';

/** Maps onto the frozen Rust commands `update_consent` / `set_update_consent` / `check_for_update`. */
export abstract class UpdatesPort {
  abstract consent(): Promise<UpdateConsent>;
  abstract setConsent(consent: UpdateConsent): Promise<void>;
  abstract check(manual: boolean): Promise<UpdateCheck>;
}
