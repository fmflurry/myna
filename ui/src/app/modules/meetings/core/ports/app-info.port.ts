/** Maps onto the frozen Rust command app_version. */
export abstract class AppInfoPort {
  abstract version(): Promise<string>;
}
