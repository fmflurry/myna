export type FolderId = string & { readonly __brand: 'FolderId' };

export const toFolderId = (id: string): FolderId => id as FolderId;

export interface Folder {
  readonly id: FolderId;
  readonly name: string;
  readonly createdAt: Date;
  readonly position: number;
}

export const withName = (folder: Folder, name: string): Folder => ({
  ...folder,
  name,
});
