/**
 * Mirrors the Rust `FolderDto` (`#[serde(rename_all = "camelCase")]`).
 */
export interface FolderDto {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly position: number;
}
