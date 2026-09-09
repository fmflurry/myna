# app

Tauri 2 shell for Myna: `src-tauri/` holds the Rust core plus window/webview
wiring, per docs/stack-proposal.md.

## Layout

- `src-tauri/` — the `myna-app` Cargo workspace member (crate name
  `myna_app`, binary `myna`).
  - `src/lib.rs` — builds the `tauri::Builder`, registers the `dialog` and
    `updater` plugins (updater is Rust-side only; the webview has no
    capability to reach it — ADR 0010/0012) and the typed
    `#[tauri::command]` surface under `src/commands/` (recording, meetings,
    transcript editing, summaries, templates, models, folders, import,
    export, storage, updates).
  - `src/main.rs` — binary entry point.
  - `src/paths.rs` — resolves on-disk locations: the meetings data root
    (`~/myna` by default; `MYNA_DATA_DIR` > Settings pointer > `~/myna`,
    meetings/preferences/folders only — `MYNA_DATA_DIR` never affects
    models), the meetings directory, and the fixed models/templates
    resource directories (repo-relative in dev, bundled resources in
    release; models fixed at `~/myna/models`, `MYNA_MODELS_DIR` only
    override; templates overridable via `MYNA_TEMPLATES_DIR`).
  - `tauri.conf.json` — window, CSP, and bundle configuration.
  - `capabilities/default.json` — the main window's permission set
    (`core:default`, `dialog:allow-save`, `dialog:allow-open`). No
    filesystem permissions are granted here — all disk access goes through
    typed Rust commands.
  - `Info.plist` — merged into the generated macOS bundle by the Tauri CLI;
    carries `NSMicrophoneUsageDescription` so macOS grants mic access to
    cpal at runtime (without it, capture fails silently) and
    `NSAudioCaptureUsageDescription` for system-audio capture via Core
    Audio process taps (ADR 0007).
  - `icons/` — regenerated from `myna-brand-kit/myna-app-icon.svg` via
    `scripts/generate-icons.sh` (respects the Big Sur safe area).

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
