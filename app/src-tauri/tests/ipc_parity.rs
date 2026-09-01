//! Drift guard between the UI's frozen command surface
//! (`ui/src/app/modules/meetings/infrastructure/tauri/commands.ts`,
//! `COMMAND_NAMES`) and the Rust `invoke_handler` registration in
//! `app/src-tauri/src/lib.rs`.
//!
//! A name that exists only in TypeScript compiles and lints cleanly but
//! fails at runtime with "command not found" — the exact regression that
//! left the app stuck on "Checking installed models…" with a silently
//! swallowed error. This test turns that class of runtime failure into a
//! plain `cargo test` failure.

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

/// Extracts the command names from the `COMMAND_NAMES` array in
/// `commands.ts`: everything between `export const COMMAND_NAMES = [` and
/// the closing `] as const`, taken from single-quoted string literals.
fn ui_command_names() -> BTreeSet<String> {
    let source = fs::read_to_string(repo_file(
        "../../ui/src/app/modules/meetings/infrastructure/tauri/commands.ts",
    ))
    .expect("ui commands.ts must exist — did the path move?");
    let start = source
        .find("export const COMMAND_NAMES = [")
        .expect("COMMAND_NAMES array in commands.ts");
    let body = &source[start..];
    let end = body.find("] as const").expect("`] as const` terminator");
    names_in_quotes(&body[..end])
}

/// Extracts the command names registered in `tauri::generate_handler![..]`
/// in `lib.rs`: each entry is `commands::<module>::<name>,`; the final path
/// segment is the command name.
fn registered_command_names() -> BTreeSet<String> {
    let source = fs::read_to_string(repo_file("src/lib.rs")).expect("src/lib.rs must exist");
    let start = source
        .find("tauri::generate_handler![")
        .expect("generate_handler in lib.rs");
    let body = &source[start..];
    let end = body.find("])").expect("generate_handler closing `])`");
    body[..end]
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("commands::"))
        .map(|line| {
            line.trim_end_matches(',')
                .rsplit("::")
                .next()
                .expect("commands::module::name entry")
                .to_string()
        })
        .collect()
}

fn names_in_quotes(text: &str) -> BTreeSet<String> {
    text.split('\'')
        .skip(1)
        .step_by(2)
        .map(str::to_string)
        .collect()
}

#[test]
fn every_ui_command_name_is_registered_in_the_invoke_handler() {
    let ui_names = ui_command_names();
    let registered = registered_command_names();

    let missing: Vec<&String> = ui_names
        .iter()
        .filter(|name| !registered.contains(*name))
        .collect();
    assert!(
        missing.is_empty(),
        "UI commands.ts declares these commands, but lib.rs invoke_handler does NOT \
         register them (runtime 'command not found'): {missing:?}"
    );
}

#[test]
fn every_registered_command_is_declared_in_ui_commands_ts() {
    let ui_names = ui_command_names();
    let registered = registered_command_names();

    let untracked: Vec<&String> = registered
        .iter()
        .filter(|name| !ui_names.contains(*name))
        .collect();
    assert!(
        untracked.is_empty(),
        "lib.rs registers commands missing from the UI's frozen COMMAND_NAMES list \
         (dead or drift): {untracked:?}"
    );
}

#[test]
fn ui_command_names_list_is_not_empty() {
    // Guards the parser itself: a regex/parse slip that yields an empty set
    // would make the parity assertions vacuously pass.
    let ui_names = ui_command_names();
    assert!(
        ui_names.len() >= 40,
        "expected the frozen command surface to have at least 40 entries, got {}",
        ui_names.len()
    );
    assert!(ui_names.contains("list_meetings"));
    assert!(ui_names.contains("get_meeting_audio_path"));
}

/// Sanity-check the lib.rs parser against a known-registered name without
/// touching the shared helpers' failure modes.
#[test]
fn registered_names_include_the_boot_critical_commands() {
    let registered = registered_command_names();
    for name in [
        "list_meetings",
        "models_status",
        "list_templates",
        "start_model_download",
    ] {
        assert!(
            registered.contains(name),
            "boot-critical command {name} must stay registered"
        );
    }
}
