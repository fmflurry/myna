//! Custom application menu.
//!
//! Mirrors Tauri's built-in default menu (`tauri-2.11.5/src/menu/menu.rs`,
//! `Menu::default`) item-for-item — app submenu (macOS only), File, Edit,
//! View, Window, Help, including the `About` metadata derived from
//! `package_info` — and adds a single "Settings…" item to the app submenu,
//! placed right after `About` + separator. The default menu is only kept
//! while `app.menu.is_none()`, so installing this one replaces it entirely;
//! every predefined item (especially the Edit clipboard roles) must
//! therefore be reproduced exactly or platform shortcuts silently break.
//!
//! Clicking "Settings…" emits [`events::MENU_SETTINGS`] to the webview with
//! an empty payload; the UI owns what "settings" means from there.

#[cfg(target_os = "macos")]
use tauri::menu::MenuItem;
use tauri::menu::{
    AboutMetadata, Menu, MenuEvent, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, Wry};

use crate::events;

/// Menu-item id for the "Settings…" entry. Stable wire contract with
/// [`handle`]; the frontend never sees it, but tests and future menu
/// handlers match on it.
pub const SETTINGS_ITEM_ID: &str = "settings";

/// Accelerator for "Settings…" as a muda-parseable string. `MenuItem::with_id`
/// drops unparseable accelerators *silently* (tauri-2.11.5/src/menu/normal.rs:65),
/// so [`tests::settings_accelerator_parses_via_muda`] guards this constant.
/// `cfg(test)` keeps the guard test compiling on non-macOS hosts, where the
/// only production consumer (`app_submenu`) is not built.
#[cfg(any(test, target_os = "macos"))]
const SETTINGS_ACCELERATOR: &str = "CmdOrCtrl+,";

/// Builds the application menu: Tauri's default layout plus "Settings…".
///
/// Must be called on the main thread (the setup hook qualifies); every
/// tauri menu constructor round-trips through it anyway.
pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let window_menu = window_submenu(app)?;
    let help_menu = help_submenu(app)?;

    Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &app_submenu(app)?,
            #[cfg(not(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd"
            )))]
            &file_submenu(app)?,
            &edit_submenu(app)?,
            #[cfg(target_os = "macos")]
            &view_submenu(app)?,
            &window_menu,
            &help_menu,
        ],
    )
}

/// Routes a menu event: a click on "Settings…" emits
/// [`events::MENU_SETTINGS`] with an empty payload to the webview. Every
/// other id (all predefined items) is left to tauri's own handling.
pub fn handle(app: &AppHandle, event: &MenuEvent) {
    if event.id() == SETTINGS_ITEM_ID {
        // An emit failure is only possible before the webview is attached; the
        // title-bar gear button remains as a fallback path into Settings.
        let _ = app.emit(events::MENU_SETTINGS, ());
    }
}

fn about_metadata(app: &AppHandle) -> AboutMetadata<'static> {
    let pkg_info = app.package_info();
    let config = app.config();
    AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    }
}

/// The macOS app submenu (titled with the package name), identical to
/// tauri's default except for the extra "Settings…" item + separator
/// inserted between `About` + separator and `Services` (macOS HIG groups
/// preferences as its own section).
#[cfg(target_os = "macos")]
fn app_submenu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    Submenu::with_items(
        app,
        app.package_info().name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about_metadata(app)))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                SETTINGS_ITEM_ID,
                "Settings…",
                true,
                Some(SETTINGS_ACCELERATOR),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )
}

// Windows/Linux: expose Settings in file_submenu when those targets ship
// (the macOS-only app submenu is where it lives today).
#[cfg(not(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
)))]
fn file_submenu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    Submenu::with_items(
        app,
        "File",
        true,
        &[
            &PredefinedMenuItem::close_window(app, None)?,
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )
}

/// Clipboard/undo roles. Losing this submenu means Cmd+C/V/X stop working
/// in the webview — keep it item-for-item with upstream.
fn edit_submenu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )
}

#[cfg(target_os = "macos")]
fn view_submenu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )
}

/// Ids must match tauri's `WINDOW_SUBMENU_ID` / `HELP_SUBMENU_ID` so the
/// framework keeps finding its own window/help slots (as `Menu::default`
/// does upstream).
fn window_submenu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )
}

fn help_submenu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    Submenu::with_id_and_items(
        app,
        HELP_SUBMENU_ID,
        "Help",
        true,
        &[
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::about(app, None, Some(about_metadata(app)))?,
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_accelerator_parses_via_muda() {
        // MenuItem::with_id swallows parse errors (normal.rs:65), so a typo
        // here would ship a Settings item with no shortcut and no failure.
        let parsed: muda::accelerator::Accelerator = SETTINGS_ACCELERATOR
            .parse()
            .expect("SETTINGS_ACCELERATOR must parse as a muda Accelerator");
        assert_eq!(parsed.key(), muda::accelerator::Code::Comma);
        assert!(parsed.modifiers().contains(muda::accelerator::CMD_OR_CTRL));
    }

    #[test]
    fn settings_item_id_is_stable() {
        // The id is matched in `handle`; renaming it must be a deliberate act.
        assert_eq!(SETTINGS_ITEM_ID, "settings");
    }
}
