//! Summary template listing.

use tauri::AppHandle;

use myna_llm::Template;

use crate::error::AppError;
use crate::paths;

/// Lists every valid summary template found under the templates root.
///
/// `Template` is `Serialize` and crosses the Tauri IPC boundary directly —
/// no extra DTO is needed.
///
/// `async fn`: reads and parses every template file under the templates
/// root, so it runs inside [`tauri::async_runtime::spawn_blocking`] rather
/// than the main thread.
#[tauri::command]
pub async fn list_templates(app: AppHandle) -> Result<Vec<Template>, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(myna_llm::list_templates(&paths::templates_root(&app))?)
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Store(
            "list_templates worker thread panicked".to_string(),
        ))
    })
}
