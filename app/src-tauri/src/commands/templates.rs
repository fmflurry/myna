//! Summary template listing and per-template prompt overrides.

use tauri::AppHandle;

use myna_llm::Template;

use crate::error::AppError;
use crate::paths;
use crate::template_prefs;

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

/// Returns the effective prompt for `name`: the persisted override when one
/// exists, otherwise the built-in template's prompt.
///
/// Fails with [`AppError::Store`] when `name` is not a single safe segment
/// (`^[a-z0-9-]+$`), and with [`AppError::NotFound`] when no built-in
/// template carries that name.
///
/// `async fn`: template discovery plus preferences I/O, so it runs inside
/// [`tauri::async_runtime::spawn_blocking`] like [`list_templates`].
#[tauri::command]
pub async fn get_template_prompt(app: AppHandle, name: String) -> Result<String, AppError> {
    tauri::async_runtime::spawn_blocking(move || get_template_prompt_blocking(&app, &name))
        .await
        .unwrap_or_else(|_| {
            Err(AppError::Store(
                "get_template_prompt worker thread panicked".to_string(),
            ))
        })
}

fn get_template_prompt_blocking(app: &AppHandle, name: &str) -> Result<String, AppError> {
    if !template_prefs::is_valid_template_name(name) {
        return Err(AppError::Store(format!(
            "template name '{name}' must match ^[a-z0-9-]+$"
        )));
    }
    let builtin = myna_llm::list_templates(&paths::templates_root(app))?
        .into_iter()
        .find(|candidate| candidate.name == name)
        .ok_or_else(|| AppError::NotFound(format!("template '{name}'")))?;
    let root = paths::data_root().map_err(|err| AppError::Path(err.to_string()))?;
    let prefs = template_prefs::load(&root);
    Ok(prefs
        .get(name)
        .map(str::to_string)
        .unwrap_or(builtin.prompt))
}

/// Persists a per-template prompt override for `name` and returns the
/// normalized prompt (trimmed and capped via
/// [`template_prefs::normalize_prompt`]).
///
/// The normalized prompt is validated with the same rules as
/// [`Template::validate`]: non-empty, contains the `{transcript}`
/// placeholder, and contains no unknown `{...}` placeholders. Failures
/// surface as [`AppError::Store`]; an unknown template name surfaces as
/// [`AppError::NotFound`], and a malformed name as [`AppError::Store`].
///
/// `async fn`: template discovery plus preferences I/O, so it runs inside
/// [`tauri::async_runtime::spawn_blocking`] like [`list_templates`].
#[tauri::command]
pub async fn set_template_prompt(
    app: AppHandle,
    name: String,
    prompt: String,
) -> Result<String, AppError> {
    tauri::async_runtime::spawn_blocking(move || set_template_prompt_blocking(&app, &name, &prompt))
        .await
        .unwrap_or_else(|_| {
            Err(AppError::Store(
                "set_template_prompt worker thread panicked".to_string(),
            ))
        })
}

fn set_template_prompt_blocking(
    app: &AppHandle,
    name: &str,
    prompt: &str,
) -> Result<String, AppError> {
    if !template_prefs::is_valid_template_name(name) {
        return Err(AppError::Store(format!(
            "template name '{name}' must match ^[a-z0-9-]+$"
        )));
    }
    let known = myna_llm::list_templates(&paths::templates_root(app))?
        .into_iter()
        .any(|candidate| candidate.name == name);
    if !known {
        return Err(AppError::NotFound(format!("template '{name}'")));
    }
    let normalized = template_prefs::normalize_prompt(prompt);
    let probe = Template {
        name: name.to_owned(),
        description: "custom prompt override".to_owned(),
        prompt: normalized.clone(),
        section_schema: None,
        label: None,
        emoji: None,
    };
    probe.validate().map_err(|err| match err {
        myna_llm::LlmError::Template(message) => AppError::Store(message),
        other => AppError::Store(other.to_string()),
    })?;
    let root = paths::data_root().map_err(|err| AppError::Path(err.to_string()))?;
    let mut prefs = template_prefs::load(&root);
    if !prefs.set(name, &normalized) {
        return Err(AppError::Store(format!(
            "template name '{name}' must match ^[a-z0-9-]+$"
        )));
    }
    template_prefs::save(&root, &prefs)?;
    Ok(normalized)
}

/// Deletes the persisted prompt override for `name`, restoring the built-in
/// prompt. Idempotent: succeeds even when no override exists.
///
/// Fails with [`AppError::Store`] when `name` is malformed and with
/// [`AppError::NotFound`] when no built-in template carries that name.
///
/// `async fn`: template discovery plus preferences I/O, so it runs inside
/// [`tauri::async_runtime::spawn_blocking`] like [`list_templates`].
#[tauri::command]
pub async fn reset_template_prompt(app: AppHandle, name: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || reset_template_prompt_blocking(&app, &name))
        .await
        .unwrap_or_else(|_| {
            Err(AppError::Store(
                "reset_template_prompt worker thread panicked".to_string(),
            ))
        })
}

fn reset_template_prompt_blocking(app: &AppHandle, name: &str) -> Result<(), AppError> {
    if !template_prefs::is_valid_template_name(name) {
        return Err(AppError::Store(format!(
            "template name '{name}' must match ^[a-z0-9-]+$"
        )));
    }
    let known = myna_llm::list_templates(&paths::templates_root(app))?
        .into_iter()
        .any(|candidate| candidate.name == name);
    if !known {
        return Err(AppError::NotFound(format!("template '{name}'")));
    }
    let root = paths::data_root().map_err(|err| AppError::Path(err.to_string()))?;
    let mut prefs = template_prefs::load(&root);
    prefs.reset(name);
    template_prefs::save(&root, &prefs)
}
