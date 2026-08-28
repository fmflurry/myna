/**
 * Simple key-value preference storage, abstracted from its backing
 * mechanism (localStorage today; could become a Tauri-persisted store
 * later without any caller needing to change).
 */
export abstract class PreferencesPort {
  abstract get(key: string): string | null;
  abstract set(key: string, value: string): void;
}
