//! Drift guard between the UI's frozen event surface
//! (`ui/src/app/modules/meetings/infrastructure/tauri/events.ts`,
//! `EVENT_NAMES`) and the Rust event-name constants in
//! `app/src-tauri/src/events.rs`.
//!
//! A name that exists only in TypeScript compiles and lints cleanly but
//! never fires at runtime — the listener waits on an event the core never
//! emits. A name that exists only in Rust is a dead emission. This test
//! turns both classes of silent drift into a plain `cargo test` failure,
//! mirroring `ipc_parity.rs` for the command surface.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

/// Reads a repo file relative to the crate root (`app/src-tauri`).
fn repo_file(relative: &str) -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for part in relative.split('/') {
        path.push(part);
    }
    path
}

/// Extracts the event names from the `EVENT_NAMES` array in
/// `events.ts`: everything between `export const EVENT_NAMES = [` and
/// the closing `] as const`, taken from single-quoted string literals.
fn ui_event_names() -> BTreeSet<String> {
    let source = fs::read_to_string(repo_file(
        "../../ui/src/app/modules/meetings/infrastructure/tauri/events.ts",
    ))
    .expect("ui events.ts must exist — did the path move?");
    let start = source
        .find("export const EVENT_NAMES = [")
        .expect("EVENT_NAMES array in events.ts");
    let body = &source[start..];
    let end = body.find("] as const").expect("`] as const` terminator");
    names_in_single_quotes(&body[..end])
}

/// Extracts the event-name values from `pub const <NAME>: &str = "<value>";`
/// declarations in `src/events.rs`.
fn rust_event_names() -> BTreeSet<String> {
    let source = fs::read_to_string(repo_file("src/events.rs")).expect("src/events.rs must exist");
    source
        .lines()
        .filter_map(|line| {
            let line = line.trim_start();
            if !line.starts_with("pub const") {
                return None;
            }
            let marker = ": &str = \"";
            let (_, after) = line.split_once(marker)?;
            let end = after.find('"')?;
            Some(after[..end].to_string())
        })
        .collect()
}

fn names_in_single_quotes(text: &str) -> BTreeSet<String> {
    text.split('\'')
        .skip(1)
        .step_by(2)
        .map(str::to_string)
        .collect()
}

#[test]
fn every_ui_event_name_is_declared_in_rust_events_rs() {
    let ui_names = ui_event_names();
    let rust_names = rust_event_names();

    let unemitted: Vec<&String> = ui_names
        .iter()
        .filter(|name| !rust_names.contains(*name))
        .collect();
    assert!(
        unemitted.is_empty(),
        "UI events.ts listens for these events, but src/events.rs declares NO \
         matching constant (the listener will never fire): {unemitted:?}"
    );
}

#[test]
fn every_rust_event_name_is_declared_in_ui_events_ts() {
    let ui_names = ui_event_names();
    let rust_names = rust_event_names();

    let untracked: Vec<&String> = rust_names
        .iter()
        .filter(|name| !ui_names.contains(*name))
        .collect();
    assert!(
        untracked.is_empty(),
        "src/events.rs emits these events but the UI's frozen EVENT_NAMES list \
         does not track them (dead or drift): {untracked:?}"
    );
}

#[test]
fn event_name_lists_are_not_empty() {
    // Guards the parsers themselves: a parse slip that yields an empty set
    // would make the parity assertions vacuously pass.
    let ui_names = ui_event_names();
    let rust_names = rust_event_names();
    assert!(
        ui_names.len() >= 13,
        "expected the frozen event surface to have at least 13 entries, got {}",
        ui_names.len()
    );
    assert!(
        rust_names.len() >= 13,
        "expected src/events.rs to declare at least 13 event constants, got {}",
        rust_names.len()
    );
    for names in [&ui_names, &rust_names] {
        assert!(names.contains("recording://state"));
        assert!(names.contains("menu://settings"));
    }
}
