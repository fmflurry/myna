import { Injectable } from '@angular/core';

import { PreferencesPort } from '../../core/ports/preferences.port';

/** In-memory PreferencesPort implementation for specs and the placeholder providers. */
@Injectable()
export class InMemoryPreferencesFake extends PreferencesPort {
  private readonly values = new Map<string, string>();

  override get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  override set(key: string, value: string): void {
    this.values.set(key, value);
  }
}
