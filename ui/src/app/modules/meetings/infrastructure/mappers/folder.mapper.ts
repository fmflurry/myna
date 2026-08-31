import { toFolderId } from '../../core/models/folder.model';
import type { Folder } from '../../core/models/folder.model';
import type { FolderDto } from '../dto/folder.dto';

/** Maps a `FolderDto` to the domain `Folder`. */
export function mapFolderDtoToDomain(dto: FolderDto): Folder {
  return {
    id: toFolderId(dto.id),
    name: dto.name,
    createdAt: new Date(dto.createdAt),
    position: dto.position,
  };
}
