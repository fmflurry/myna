/**
 * Maps onto the native OS save dialog (backed by the `tauri-plugin-dialog`
 * crate). Returns the chosen absolute path, or `null` when the user
 * cancels the dialog — never throws for a cancellation.
 */
export abstract class FileDialogPort {
  abstract save(suggestedName: string, extension: string): Promise<string | null>;
}
