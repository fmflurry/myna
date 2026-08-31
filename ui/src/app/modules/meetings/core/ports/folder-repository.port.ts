import type { Folder, FolderId } from '../models/folder.model';

/**
 * Maps onto the frozen Rust commands list_folders, create_folder,
 * rename_folder and delete_folder.
 */
export abstract class FolderRepositoryPort {
  abstract list(): Promise<readonly Folder[]>;
  abstract create(name: string): Promise<Folder>;
  abstract rename(id: FolderId, name: string): Promise<Folder>;
  abstract delete(id: FolderId): Promise<void>;
}
