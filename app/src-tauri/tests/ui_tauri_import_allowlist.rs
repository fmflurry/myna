//! Guard for the Tauri import allowlist documented in the repo root
//! `CLAUDE.md` ("Only two files may import Tauri packages: `ipc.ts` ...
//! and `tauri-file-dialog.adapter.ts` ... Keeps the Tauri boundary
//! isolated.").
//!
//! That boundary exists only as prose today. Nothing stops a future
//! feature (e.g. an in-app updater) from importing
//! `@tauri-apps/plugin-updater` straight into a component or a new
//! adapter, which would silently widen the boundary the architecture
//! depends on. This test walks every `.ts` and `.html` file under
//! `ui/src`, collects the ones that reference `@tauri-apps/`, and fails
//! loudly the moment that set drifts from the frozen allowlist.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

const TAURI_IMPORT_MARKER: &str = "@tauri-apps/";

/// Files permitted to reference `@tauri-apps/`, relative to `ui/src`.
/// See CLAUDE.md: "Only two files may import Tauri packages... Keeps the
/// Tauri boundary isolated."
const ALLOWLIST: &[&str] = &[
    "app/modules/meetings/infrastructure/tauri/ipc.ts",
    "app/modules/meetings/infrastructure/tauri/tauri-file-dialog.adapter.ts",
];

/// Resolves `ui/src` relative to the crate root (`app/src-tauri`).
fn ui_src_root() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for part in ["..", "..", "ui", "src"] {
        path.push(part);
    }
    path
}

/// Recursively collects every `.ts` / `.html` file under `dir`.
fn collect_ts_and_html_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = fs::read_dir(dir)
        .unwrap_or_else(|err| panic!("failed to read dir {}: {err}", dir.display()));
    for entry in entries {
        let entry = entry.expect("dir entry");
        let path = entry.path();
        if path.is_dir() {
            collect_ts_and_html_files(&path, out);
            continue;
        }
        let is_ts_or_html = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext == "ts" || ext == "html")
            .unwrap_or(false);
        if is_ts_or_html {
            out.push(path);
        }
    }
}

/// Files under `ui/src` whose contents reference `@tauri-apps/`, as paths
/// relative to `ui/src` with forward slashes (portable across platforms).
fn files_importing_tauri() -> BTreeSet<String> {
    let root = ui_src_root();
    assert!(
        root.is_dir(),
        "ui/src must exist at {} — did the path move?",
        root.display()
    );

    let mut files = Vec::new();
    collect_ts_and_html_files(&root, &mut files);
    assert!(
        files.len() >= 20,
        "expected at least 20 .ts/.html files under ui/src, found {} — \
         did the walk break?",
        files.len()
    );

    files
        .into_iter()
        .filter(|path| {
            let contents = fs::read_to_string(path)
                .unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()));
            contents.contains(TAURI_IMPORT_MARKER)
        })
        .map(|path| {
            path.strip_prefix(&root)
                .expect("file under ui/src root")
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect()
}

#[test]
fn only_the_allowlisted_files_import_tauri_packages() {
    let actual = files_importing_tauri();
    let allowed: BTreeSet<String> = ALLOWLIST.iter().map(|s| s.to_string()).collect();

    let unauthorized: Vec<&String> = actual.difference(&allowed).collect();
    assert!(
        unauthorized.is_empty(),
        "the following file(s) under ui/src reference `@tauri-apps/` but are NOT \
         in the two-file Tauri import allowlist: {unauthorized:?}. \
         CLAUDE.md says: \"Only two files may import Tauri packages: \
         `infrastructure/tauri/ipc.ts` ... and \
         `infrastructure/tauri/tauri-file-dialog.adapter.ts` ... Keeps the \
         Tauri boundary isolated.\" Route this import through one of the \
         two allowlisted files instead of importing `@tauri-apps/*` directly."
    );

    let missing: Vec<&String> = allowed.difference(&actual).collect();
    assert!(
        missing.is_empty(),
        "the allowlist in this test names file(s) that no longer reference \
         `@tauri-apps/` at all: {missing:?}. Update ALLOWLIST in \
         app/src-tauri/tests/ui_tauri_import_allowlist.rs (and CLAUDE.md) to \
         match reality."
    );
}
