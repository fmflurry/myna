# app

Tauri 2 shell for Myna: `src-tauri/` holds the Rust core plus window/webview
wiring, per docs/stack-proposal.md.

## Layout

- `src-tauri/` — the `myna-app` Cargo workspace member (crate name
  `myna_app`, binary `myna`).
  - `src/lib.rs` — builds the `tauri::Builder`, registers the `dialog` and
    `opener` plugins. The invoke handler is intentionally empty; the typed
    `#[tauri::command]` surface is added in a later phase.
  - `src/main.rs` — binary entry point.
  - `src/paths.rs` — resolves on-disk locations: the user's data root
    (`~/myna` by default, overridable via `MYNA_DATA_DIR`), the meetings
    directory, and the models/templates resource directories (repo-relative
    in dev, bundled resources in release; overridable via `MYNA_MODELS_DIR`
    / `MYNA_TEMPLATES_DIR`).
  - `tauri.conf.json` — window, CSP, and bundle configuration.
  - `capabilities/default.json` — the main window's permission set
    (`core:default`, `dialog:allow-save`, `opener:allow-open-url`). No
    filesystem permissions are granted here — all disk access goes through
    typed Rust commands added in later phases.
  - `Info.plist` — merged into the generated macOS bundle by the Tauri CLI;
    carries `NSMicrophoneUsageDescription` so macOS grants mic access to
    cpal at runtime (without it, capture fails silently).
  - `icons/` — generated via `npx tauri icon` from a placeholder source
    image; replace with real branding before release.

## Dev commands

From the repo root:

```bash
npm install
npx tauri info      # verify the toolchain + plugin versions
npm run tauri dev    # launches the Angular dev server, then the app window
npm run tauri build  # produces the ui:build output, then bundles the app
```

The `ui:dev` / `ui:build` npm scripts (invoked by `beforeDevCommand` /
`beforeBuildCommand`) proxy into `ui/` via `npm --prefix ui run <script>`.
