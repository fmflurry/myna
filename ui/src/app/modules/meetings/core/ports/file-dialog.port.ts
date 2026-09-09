export interface FileDialogFilter {
  readonly name: string;
  readonly extensions: readonly string[];
}

/**
 * Maps onto the native OS save/open dialogs (backed by the
 * `tauri-plugin-dialog` crate). Both `save()` and `open()` return the
 * chosen absolute path, or `null` when the user cancels the dialog — never
 * throws for a cancellation.
 */
export abstract class FileDialogPort {
  abstract save(suggestedName: string, extension: string): Promise<string | null>;
  abstract open(filters: readonly FileDialogFilter[]): Promise<string | null>;
  /**
   * Maps onto the native OS directory picker (the dialog plugin's open
   * entry with directory selection enabled). Returns the chosen absolute
   * directory path, or `null` when the user cancels — never throws for a
   * cancellation.
   */
  abstract selectDirectory(): Promise<string | null>;
}
