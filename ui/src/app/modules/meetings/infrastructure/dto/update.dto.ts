/**
 * Update-related DTOs. Canonically declared alongside the frozen Tauri
 * command surface in `infrastructure/tauri/commands.ts` (so
 * `CommandSignatures['check_for_update']` etc. never drifts from these
 * shapes) and re-exported here so adapters/mappers can import from the
 * conventional `dto/` path.
 */
export type {
  UpdateCheckDto,
  UpdateCheckStatusDto,
  UpdateConsentDto,
  UpdateSkipReasonDto,
} from '../tauri/commands';
