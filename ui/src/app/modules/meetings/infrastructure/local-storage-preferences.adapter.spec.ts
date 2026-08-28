import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalStoragePreferencesAdapter } from './local-storage-preferences.adapter';

describe('LocalStoragePreferencesAdapter', () => {
  let adapter: LocalStoragePreferencesAdapter;

  beforeEach(() => {
    localStorage.clear();
    adapter = new LocalStoragePreferencesAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null for a key that was never set', () => {
    expect(adapter.get('meetings.missingKey')).toBeNull();
  });

  it('round-trips a value through set then get', () => {
    adapter.set('meetings.summaryLanguage', 'fr');

    expect(adapter.get('meetings.summaryLanguage')).toBe('fr');
  });

  it('returns null instead of throwing when localStorage.getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    expect(() => adapter.get('meetings.summaryLanguage')).not.toThrow();
    expect(adapter.get('meetings.summaryLanguage')).toBeNull();
  });

  it('silently no-ops instead of throwing when localStorage.setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    expect(() => adapter.set('meetings.summaryLanguage', 'fr')).not.toThrow();
  });
});
