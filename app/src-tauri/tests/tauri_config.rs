//! Guards the fix for a packaged-app-only drag-and-drop bug: with
//! `dragDropEnabled` absent (defaulting to `true`), `tauri-runtime-wry`
//! installs a native drag handler whose closure returns `true`
//! unconditionally (`tauri-runtime-wry-2.11.4/src/lib.rs:4862,4896`). In
//! `wry-0.55.1/src/wkwebview/drag_drop.rs:44-49,65-77,88-94`, `WryWebView`'s
//! overrides of `draggingEntered:` / `draggingUpdated:` /
//! `performDragOperation:` / `draggingExited:` (an `NSDraggingDestination`
//! implementation) only fall through to `super` — i.e. let WebKit itself
//! synthesize the DOM `dragover`/`drop` events our Angular app listens for —
//! when that handler returns `false`. So a packaged build with the default
//! `true` silently swallows every native drag gesture before it ever reaches
//! the webview's DOM, even though the drag "starts" fine (dragstart is
//! source-side and internal to WebKit). No Vitest/jsdom test can catch this:
//! it lives in an Objective-C method override three layers below the DOM.
//! This test only proves the config knob is set; it cannot exercise the
//! native drag path itself.
use std::fs;
use std::path::PathBuf;

#[test]
fn window_config_disables_tauri_drag_drop() {
    let config_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
    let raw = fs::read_to_string(&config_path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", config_path.display()));
    let config: serde_json::Value =
        serde_json::from_str(&raw).expect("tauri.conf.json must be valid JSON");

    let windows = config["app"]["windows"]
        .as_array()
        .expect("app.windows must be an array");
    assert!(!windows.is_empty(), "app.windows must not be empty");

    for window in windows {
        assert_eq!(
            window["dragDropEnabled"],
            serde_json::json!(false),
            "app.windows[].dragDropEnabled must be explicitly false — see module doc comment",
        );
    }
}
