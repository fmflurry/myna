import type { Folder, FolderId } from '../../core/models/folder.model';
import { toFolderId } from '../../core/models/folder.model';
import type { PreferencesPort } from '../../core/ports/preferences.port';

/** Appends `folder`; never mutates `folders`. */
export const withFolderAdded = (folders: readonly Folder[], folder: Folder): readonly Folder[] => [...folders, folder];

/** Replaces the folder matching `folder.id`; never mutates `folders`. */
export const withFolderUpdated = (folders: readonly Folder[], folder: Folder): readonly Folder[] =>
  folders.map((existing) => (existing.id === folder.id ? folder : existing));

/** Drops the folder matching `id`; never mutates `folders`. */
export const withFolderRemoved = (folders: readonly Folder[], id: FolderId): readonly Folder[] =>
  folders.filter((folder) => folder.id !== id);

/** Removes `id` from `expanded` (a no-op if absent); never mutates `expanded`. */
export const withoutFolderId = (expanded: ReadonlySet<FolderId>, id: FolderId): ReadonlySet<FolderId> => {
  const next = new Set(expanded);
  next.delete(id);
  return next;
};

/** Toggles `id`'s membership in `expanded`; never mutates `expanded`. */
export const withToggledFolderId = (expanded: ReadonlySet<FolderId>, id: FolderId): ReadonlySet<FolderId> => {
  const next = new Set(expanded);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
};

/** localStorage key the set of expanded folder ids (sidebar tree state) is persisted under. */
export const EXPANDED_FOLDERS_PREFERENCE_KEY = 'meetings.expandedFolders';

/** Reads and parses the persisted expanded-folders JSON array, defaulting to an empty set for anything unusable. */
export const readStoredExpandedFolders = (preferences: PreferencesPort): ReadonlySet<FolderId> =>
  parseExpandedFolderIds(preferences.get(EXPANDED_FOLDERS_PREFERENCE_KEY));

/** Persists the given expanded-folders set as a JSON array of ids. */
export const storeExpandedFolders = (preferences: PreferencesPort, ids: ReadonlySet<FolderId>): void => {
  preferences.set(EXPANDED_FOLDERS_PREFERENCE_KEY, JSON.stringify([...ids]));
};

const parseExpandedFolderIds = (raw: string | null): ReadonlySet<FolderId> => {
  if (raw === null) {
    return new Set();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set((parsed as unknown[]).filter((id): id is string => typeof id === 'string').map(toFolderId));
  } catch {
    return new Set();
  }
};
