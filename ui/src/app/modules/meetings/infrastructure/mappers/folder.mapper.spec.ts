import { toFolderId } from '../../core/models/folder.model';
import { mapFolderDtoToDomain } from './folder.mapper';

describe('mapFolderDtoToDomain', () => {
  it('maps createdAt to a Date and preserves position', () => {
    // Arrange
    const dto = { id: 'f-1', name: 'Work', createdAt: '2026-01-15T09:00:00Z', position: 3 };

    // Act
    const folder = mapFolderDtoToDomain(dto);

    // Assert
    expect(folder.createdAt).toEqual(new Date('2026-01-15T09:00:00Z'));
    expect(folder.position).toBe(3);
  });

  it('brands the id and preserves the name', () => {
    // Arrange
    const dto = { id: 'f-2', name: 'Personal', createdAt: '2026-01-15T09:00:00Z', position: 0 };

    // Act
    const folder = mapFolderDtoToDomain(dto);

    // Assert
    expect(folder.id).toBe(toFolderId('f-2'));
    expect(folder.name).toBe('Personal');
  });
});
