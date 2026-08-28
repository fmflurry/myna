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
}
