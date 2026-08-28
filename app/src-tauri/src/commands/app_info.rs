//! App metadata exposed to the UI: currently just the semantic version, for
//! an About dialog.

use tauri::AppHandle;

/// Returns the app's semantic version.
///
/// Sourced from `app.package_info().version` rather than
/// `env!("CARGO_PKG_VERSION")` directly. Tauri's `generate_context!()`
/// macro bakes `package_info().version` from `tauri.conf.json`'s `version`
/// field at compile time when that field is set (falling back to
/// `CARGO_PKG_VERSION` only when it is absent) — see
/// `tauri-codegen::context::define_tauri_config`. Since this repo's
/// `tauri.conf.json` sets `"version": "0.1.0"`, `package_info().version`
/// *is* that value; the two cannot drift because one is compiled from the
/// other, and this is also the version Tauri stamps onto the bundled
/// binary/installer.
#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}
