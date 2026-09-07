//! Dedicated migration + storage-guard tests (review follow-up).
//!
//! Covers [`myna_app::commands::storage::migrate_data_root`] and the guards
//! around it: same-volume rename, EXDEV-style forced-copy verify
//! (count+size, delete-only-on-match), size-mismatch keeps source,
//! collisions keep both sides, symlinks skipped, `from == to` and
//! missing-source `Ok(0)` no-ops, `MYNA_DATA_DIR`-pinned refusal with the
//! pointer untouched, asset-scope rejection, and the concurrent-set guard
//! via `storage_busy`.
//!
//! Tempdirs only — never the real `~/myna`. No process-global environment
//! mutation (`std::env::set_var`/`remove_var` require `unsafe`, forbidden
//! workspace-wide): the pinned-override and scope helpers take explicit
//! parameters. No Tauri boot: migration and guards are exercised through
//! the public test seams plus [`myna_app::state::AppState`].
//!
//! Every test fn is named `storage_*` so
//! `cargo test -p myna-app storage` executes this whole file.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use myna_app::commands::models::models_status_at;
use myna_app::commands::storage::{
    migrate_data_root, migrate_data_root_with_test_options, refuse_when_data_dir_pinned_with,
    storage_path_in_scope,
};
use myna_app::error::AppError;
use myna_app::paths::{effective_data_root, resolve_models_root, validate_storage_location};
use myna_app::state::AppState;
use myna_app::storage_prefs::StoragePrefs;
use myna_app::store::folder_store::FsFolderStore;
use myna_app::store::fs_store::FsMeetingStore;

/// Writes `contents` to `dir/rel`, creating parents.
fn write_file(dir: &Path, rel: &str, contents: &[u8]) -> PathBuf {
    let path = dir.join(rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parents");
    }
    fs::write(&path, contents).expect("write file");
    path
}

/// Total bytes of every regular file under `dir`.
fn total_bytes(dir: &Path) -> u64 {
    let mut total = 0_u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(next) = stack.pop() {
        for entry in fs::read_dir(&next).expect("read dir") {
            let entry = entry.expect("dir entry");
            let kind = entry.file_type().expect("file type");
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
                stack.push(path);
            } else if kind.is_file() {
                total += path.metadata().expect("metadata").len();
            }
        }
    }
    total
}

/// Counts regular files (not symlinks, not dirs) under `dir`.
fn file_count(dir: &Path) -> u64 {
    let mut count = 0_u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(next) = stack.pop() {
        for entry in fs::read_dir(&next).expect("read dir") {
            let entry = entry.expect("dir entry");
            let kind = entry.file_type().expect("file type");
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
                stack.push(path);
            } else if kind.is_file() {
                count += 1;
            }
        }
    }
    count
}

fn fresh_state(dir: &Path) -> AppState {
    AppState::new(
        FsMeetingStore::new(dir),
        FsFolderStore::new(dir.to_path_buf()),
    )
}

fn assert_busy(result: Result<(), AppError>, case: &str) {
    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::Busy(_)),
        "expected AppError::Busy for {case}, got {err:?}"
    );
}

fn assert_path_error(result: Result<(), AppError>, case: &str) {
    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::Path(_)),
        "expected AppError::Path for {case}, got {err:?}"
    );
}

// --- migrate_data_root: same-volume fast path ------------------------------

#[test]
fn storage_migrate_same_volume_rename_moves_all_bytes() {
    // Arrange: a source archive with nested meetings.
    let sandbox = tempfile::tempdir().expect("tempdir");
    let from = sandbox.path().join("from-root");
    write_file(&from, "meetings/m1/audio.wav", b"pcm-bytes-1234");
    write_file(&from, "meetings/m1/meeting.json", b"{}");
    write_file(&from, "meetings/m2/transcript.json", b"{\"segments\":[]}");
    let expected_files = file_count(&from);
    let expected_bytes = total_bytes(&from);
    assert_eq!(expected_files, 3);
    let to = sandbox.path().join("to-root");

    // Act
    let moved = migrate_data_root(&from, &to).expect("migrate");

    // Assert: every file moved, byte-identical; the source is gone.
    assert_eq!(moved, expected_files);
    assert_eq!(file_count(&to), expected_files);
    assert_eq!(total_bytes(&to), expected_bytes);
    assert_eq!(
        fs::read(to.join("meetings/m1/audio.wav")).expect("read moved audio"),
        b"pcm-bytes-1234"
    );
    assert!(
        !from.exists(),
        "rename fast path must move the whole tree, leaving no source behind"
    );
}

#[test]
fn storage_migrate_from_equals_to_is_noop_zero() {
    // Arrange
    let sandbox = tempfile::tempdir().expect("tempdir");
    let root = sandbox.path().join("root");
    write_file(&root, "meetings/m1/audio.wav", b"pcm");

    // Act
    let moved = migrate_data_root(&root, &root).expect("migrate");

    // Assert
    assert_eq!(moved, 0);
    assert_eq!(
        fs::read(root.join("meetings/m1/audio.wav")).expect("read audio"),
        b"pcm",
        "from == to must leave the archive untouched"
    );
}

#[test]
fn storage_migrate_missing_source_creates_dest_noop_zero() {
    // Arrange: `from` does not exist; `to` does not exist either.
    let sandbox = tempfile::tempdir().expect("tempdir");
    let from = sandbox.path().join("does-not-exist");
    let to = sandbox.path().join("new-root");

    // Act
    let moved = migrate_data_root(&from, &to).expect("migrate");

    // Assert: usable empty root, zero files moved.
    assert_eq!(moved, 0);
    assert!(
        to.is_dir(),
        "missing source must still ensure the destination"
    );
}

// --- migrate_data_root: collisions ------------------------------------------

#[test]
fn storage_migrate_collision_leaves_dest_untouched_keeps_source() {
    // Arrange: both sides hold the same file name with different bytes.
    let sandbox = tempfile::tempdir().expect("tempdir");
    let from = sandbox.path().join("from-root");
    let to = sandbox.path().join("to-root");
    write_file(&from, "meetings/m1/audio.wav", b"source-bytes");
    write_file(&to, "meetings/m1/audio.wav", b"dest-bytes");

    // Act
    let moved = migrate_data_root(&from, &to).expect("migrate");

    // Assert: the destination wins, the source stays in place.
    assert_eq!(moved, 0);
    assert_eq!(
        fs::read(to.join("meetings/m1/audio.wav")).expect("read dest"),
        b"dest-bytes",
        "pre-existing destination files must never be overwritten"
    );
    assert_eq!(
        fs::read(from.join("meetings/m1/audio.wav")).expect("read source"),
        b"source-bytes",
        "the colliding source file must be left in place"
    );
}

#[test]
fn storage_migrate_directory_merge_moves_new_keeps_colliding() {
    // Arrange: overlapping meeting dirs — one shared name, one new.
    let sandbox = tempfile::tempdir().expect("tempdir");
    let from = sandbox.path().join("from-root");
    let to = sandbox.path().join("to-root");
    write_file(&from, "meetings/m1/collide.wav", b"source");
    write_file(&from, "meetings/m1/new.wav", b"new-bytes");
    write_file(&to, "meetings/m1/collide.wav", b"dest");

    // Act
    let moved = migrate_data_root(&from, &to).expect("migrate");

    // Assert
    assert_eq!(moved, 1, "only the non-colliding file moves");
    assert_eq!(
        fs::read(to.join("meetings/m1/new.wav")).expect("read new"),
        b"new-bytes"
    );
    assert_eq!(
        fs::read(to.join("meetings/m1/collide.wav")).expect("read collide"),
        b"dest"
    );
    assert!(
        from.join("meetings/m1/collide.wav").exists(),
        "the colliding source entry must remain"
    );
    assert!(
        !from.join("meetings/m1/new.wav").exists(),
        "the moved entry must leave the source"
    );
}

// --- migrate_data_root: symlinks --------------------------------------------

#[test]
#[cfg(unix)]
fn storage_migrate_skips_symlinks_never_follows() {
    use std::os::unix::fs::symlink;

    // Arrange: a real file plus a symlink to it, and a symlink to a dir.
    let sandbox = tempfile::tempdir().expect("tempdir");
    let from = sandbox.path().join("from-root");
    write_file(&from, "meetings/m1/real.wav", b"real-bytes");
    let real_dir = from.join("meetings/m1/sub");
    fs::create_dir_all(&real_dir).expect("create subdir");
    fs::write(real_dir.join("inner.wav"), b"inner").expect("write inner");
    symlink(from.join("meetings/m1/real.wav"), from.join("link-file")).expect("symlink file");
    symlink(&real_dir, from.join("link-dir")).expect("symlink dir");
    let to = sandbox.path().join("to-root");

    // Act: the same-volume fast path renames the whole tree.
    let moved = migrate_data_root(&from, &to).expect("migrate");

    // Assert: both real files moved; the links travelled as links and were
    // never followed — neither link dereferenced into a real copy of the
    // target's bytes, and no link escapes the archive.
    assert_eq!(moved, 2, "symlinks contribute 0 to the moved count");
    assert_eq!(file_count(&to), 2);
    for link in [to.join("link-file"), to.join("link-dir")] {
        assert!(
            fs::symlink_metadata(&link)
                .expect("link metadata")
                .file_type()
                .is_symlink(),
            "{link:?} must remain a symlink — the migration must never follow it"
        );
    }
    assert_eq!(
        fs::read(to.join("meetings/m1/real.wav")).expect("read real"),
        b"real-bytes"
    );
    assert!(
        !from.exists(),
        "rename fast path must move the whole tree, leaving no source behind"
    );
}

// --- EXDEV-style forced copy: verify + delete-only-on-match ------------------

#[test]
fn storage_migrate_force_copy_verifies_count_and_size_removes_source() {
    // Arrange
    let sandbox = tempfile::tempdir().expect("tempdir");
    let from = sandbox.path().join("from-root");
    write_file(&from, "meetings/m1/audio.wav", b"pcm-bytes-1234");
    write_file(&from, "meetings/m1/meeting.json", b"{\"title\":\"t\"}");
    write_file(&from, "summaries/s1.md", b"# summary");
    let expected_files = file_count(&from);
    let expected_bytes = total_bytes(&from);
    let to = sandbox.path().join("to-root");

    // Act: force the per-entry copy-verify-delete fallback even on the
    // same volume (where `rename` would otherwise succeed).
    let moved = migrate_data_root_with_test_options(&from, &to, true, false).expect("forced copy");

    // Assert: count+size verified, source deleted only after the match.
    assert_eq!(moved, expected_files);
    assert_eq!(file_count(&to), expected_files);
    assert_eq!(total_bytes(&to), expected_bytes);
    assert!(
        !from.exists(),
        "the source must be deleted only after count+size verify"
    );
}

#[test]
#[cfg(unix)]
fn storage_migrate_force_copy_tightens_permissions_to_0600_0700() {
    use std::os::unix::fs::PermissionsExt;

    // Arrange: world-readable source files (pre-hardening layout).
    let sandbox = tempfile::tempdir().expect("tempdir");
    let from = sandbox.path().join("from-root");
    let loose = write_file(&from, "meetings/m1/audio.wav", b"pcm");
    fs::set_permissions(&loose, fs::Permissions::from_mode(0o644)).expect("chmod loose");
    let to = sandbox.path().join("to-root");

    // Act
    migrate_data_root_with_test_options(&from, &to, true, false).expect("forced copy");

    // Assert: the copy lands under the at-rest policy.
    let file_mode = fs::metadata(to.join("meetings/m1/audio.wav"))
        .expect("metadata")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(
        file_mode, 0o600,
        "copied files must be 0600, got {file_mode:o}"
    );
    let dir_mode = fs::metadata(to.join("meetings/m1"))
        .expect("metadata")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(
        dir_mode, 0o700,
        "copied dirs must be 0700, got {dir_mode:o}"
    );
}

#[test]
fn storage_migrate_force_copy_size_mismatch_leaves_source_untouched() {
    // Arrange
    let sandbox = tempfile::tempdir().expect("tempdir");
    let from = sandbox.path().join("from-root");
    write_file(&from, "meetings/m1/audio.wav", b"pcm-bytes-1234");
    let to = sandbox.path().join("to-root");

    // Act: corrupt the copy before verify (simulates a short write the
    // count-only check would miss).
    let result = migrate_data_root_with_test_options(&from, &to, true, true);

    // Assert: a Store verify error, and the source is NOT deleted.
    let err = result.expect_err("size mismatch must fail the migration");
    assert!(
        matches!(err, AppError::Store(_)),
        "expected AppError::Store for a count+size mismatch, got {err:?}"
    );
    assert_eq!(
        fs::read(from.join("meetings/m1/audio.wav")).expect("read source"),
        b"pcm-bytes-1234",
        "a failed verify must leave the source untouched"
    );
}

#[test]
#[cfg(unix)]
fn storage_migrate_force_copy_skips_symlinks() {
    use std::os::unix::fs::symlink;

    // Arrange
    let sandbox = tempfile::tempdir().expect("tempdir");
    let from = sandbox.path().join("from-root");
    write_file(&from, "meetings/m1/real.wav", b"real");
    symlink(from.join("meetings/m1/real.wav"), from.join("link-file")).expect("symlink file");
    let to = sandbox.path().join("to-root");

    // Act
    let moved = migrate_data_root_with_test_options(&from, &to, true, false).expect("forced copy");

    // Assert
    assert_eq!(moved, 1);
    assert_eq!(file_count(&to), 1);
}

// --- MYNA_DATA_DIR pinned guard ----------------------------------------------

#[test]
fn storage_pinned_override_refuses_before_migrate_pointer_untouched() {
    // Arrange: a saved pointer naming dir A.
    let sandbox = tempfile::tempdir().expect("tempdir");
    let config = sandbox.path().join("config");
    let pointed_a = sandbox.path().join("root-a");
    fs::create_dir_all(&pointed_a).expect("create root-a");
    StoragePrefs::new(Some(pointed_a.clone()))
        .save(&config)
        .expect("save pointer");
    let raw_before = fs::read_to_string(config.join("storage.json")).expect("read pointer");

    // Act: the override pins the effective root — the set path must refuse
    // before any migration runs.
    let result = refuse_when_data_dir_pinned_with(Some(OsStr::new("/pinned/override")));

    // Assert: Path refusal naming the override, pointer file byte-identical.
    assert_path_error(result, "pinned MYNA_DATA_DIR");
    let raw_after = fs::read_to_string(config.join("storage.json")).expect("read pointer");
    assert_eq!(
        raw_after, raw_before,
        "a pinned refusal must not touch the persisted pointer"
    );
    assert_eq!(
        StoragePrefs::load(&config).data_dir(),
        Some(pointed_a.as_path())
    );
}

#[test]
fn storage_pinned_absent_allows_location_change() {
    // Act / Assert: no override means no refusal.
    assert!(
        refuse_when_data_dir_pinned_with(None).is_ok(),
        "unset MYNA_DATA_DIR must not refuse"
    );
}

// --- asset-scope guard --------------------------------------------------------

#[test]
fn storage_scope_accepts_inside_home_myna() {
    // Arrange: a tempdir standing in for $HOME.
    let home = tempfile::tempdir().expect("tempdir");
    let candidate = home.path().join("myna").join("archive");

    // Act / Assert
    assert!(
        storage_path_in_scope(&candidate, home.path(), &[]),
        "{} must be in scope (~/myna)",
        candidate.display()
    );
}

#[test]
fn storage_scope_accepts_inside_mobile_documents() {
    // Arrange: an iCloud Drive-style location (note the space).
    let home = tempfile::tempdir().expect("tempdir");
    let candidate = home
        .path()
        .join("Library")
        .join("Mobile Documents")
        .join("com~apple~CloudDocs")
        .join("myna");

    // Act / Assert
    assert!(
        storage_path_in_scope(&candidate, home.path(), &[]),
        "{} must be in scope (Mobile Documents)",
        candidate.display()
    );
}

#[test]
fn storage_scope_accepts_extra_app_data_roots() {
    // Arrange: an app-data dir passed as an extra root.
    let home = tempfile::tempdir().expect("tempdir");
    let app_data = tempfile::tempdir().expect("tempdir");
    let candidate = app_data.path().join("meetings");

    // Act / Assert
    assert!(
        storage_path_in_scope(&candidate, home.path(), &[app_data.path().to_path_buf()]),
        "{} must be in scope (app data dir)",
        candidate.display()
    );
}

#[test]
fn storage_scope_rejects_outside_home_myna_and_mobile_documents() {
    // Arrange: a location under neither ~/myna, Mobile Documents, nor any
    // extra root.
    let home = tempfile::tempdir().expect("tempdir");
    let elsewhere = tempfile::tempdir().expect("tempdir");
    let candidate = elsewhere.path().join("archive");

    // Act / Assert
    assert!(
        !storage_path_in_scope(&candidate, home.path(), &[]),
        "{} must be out of scope",
        candidate.display()
    );
}

// --- concurrent-set guard via storage_busy ------------------------------------

#[test]
fn storage_concurrent_set_guard_refuses_while_storage_busy() {
    // Arrange: one storage change already in flight.
    let dir = tempfile::tempdir().expect("tempdir");
    let state = fresh_state(dir.path());
    let _first = state
        .storage_guard()
        .expect("first storage_guard should succeed when idle");

    // Act: a second concurrent acquisition must fail with Busy.
    // (`StorageGuard` holds a borrow, so it has no `Debug` for
    // `expect_err` — match instead.)
    let second = state.storage_guard();
    let err = match second {
        Ok(_) => panic!("a second concurrent storage change must be refused"),
        Err(err) => err,
    };

    // Assert
    assert!(
        matches!(err, AppError::Busy(_)),
        "expected AppError::Busy for a concurrent set, got {err:?}"
    );
    assert!(state.storage_busy());
}

#[test]
fn storage_concurrent_set_guard_released_after_drop() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let state = fresh_state(dir.path());

    // Act: acquire and release via RAII drop.
    {
        let _guard = state.storage_guard().expect("storage_guard");
        assert!(state.storage_busy());
    }

    // Assert: the next change may proceed.
    assert!(!state.storage_busy());
    assert!(
        state.storage_guard().is_ok(),
        "storage_guard must succeed again once the prior guard dropped"
    );
}

#[test]
fn storage_guard_refuses_while_import_busy() {
    // Arrange: an import in flight.
    let dir = tempfile::tempdir().expect("tempdir");
    let state = fresh_state(dir.path());
    state.begin_import().expect("begin_import");

    // Act / Assert
    assert_busy(state.guard_storage_change(), "import in flight");
}

#[test]
fn storage_guard_refuses_while_summarization_busy() {
    // Arrange: a summarization in flight.
    let dir = tempfile::tempdir().expect("tempdir");
    let state = fresh_state(dir.path());
    state.begin_summarization().expect("begin_summarization");

    // Act / Assert: storageBusy includes summarizing.
    assert_busy(state.guard_storage_change(), "summarization in flight");
}

#[test]
fn storage_guard_refuses_while_session_lock_contended() {
    // Arrange: a start/stop mid-flight holds the session lock. The guard
    // reads contention as busy without blocking.
    let dir = tempfile::tempdir().expect("tempdir");
    let state = fresh_state(dir.path());
    let _session_lock = state.session.lock().expect("session lock");

    // Act / Assert
    assert_busy(state.guard_storage_change(), "contended session lock");
}

#[test]
fn storage_guard_refuses_while_stop_finalizing() {
    // Arrange: a stop/cancel finalization marker.
    let dir = tempfile::tempdir().expect("tempdir");
    let state = fresh_state(dir.path());
    let _stopping = state.begin_stopping(myna_app::domain::MeetingId::new(), 12.5);

    // Act / Assert
    assert_busy(state.guard_storage_change(), "stop finalizing");
}

#[test]
fn storage_guard_allows_change_when_idle() {
    // Arrange: a fresh, idle state.
    let dir = tempfile::tempdir().expect("tempdir");
    let state = fresh_state(dir.path());

    // Act / Assert
    assert!(
        state.guard_storage_change().is_ok(),
        "an idle app must allow a storage change"
    );
}

// --- top-level models/ is never migrated ------------------------------------
//
// Model weights live at the fixed `~/myna/models`, never inside the meetings
// archive: a top-level `models/` entry is skipped on every migration path
// (same-volume rename enumeration and the EXDEV copy fallback alike).

#[test]
fn migrate_skips_top_level_models_dir() {
    // Arrange + Act + Assert for both the rename path (`force_copy: false`)
    // and the EXDEV-style copy fallback (`force_copy: true`): each mode gets
    // a fresh sandbox holding a top-level `models/` weights dir beside a
    // `meetings/` archive.
    for force_copy in [false, true] {
        let sandbox = tempfile::tempdir().expect("tempdir");
        let from = sandbox.path().join("from-root");
        write_file(
            &from,
            "models/parakeet-tdt-0.6b-v3-int8/encoder.int8.onnx",
            b"weights",
        );
        write_file(&from, "meetings/m1/audio.wav", b"pcm-bytes");
        write_file(&from, "meetings/m1/meeting.json", b"{}");
        let to = sandbox.path().join("to-root");

        // Act
        let moved =
            migrate_data_root_with_test_options(&from, &to, force_copy, false).expect("migrate");

        // Assert: only the meetings files move and count; `models/` stays
        // behind at the source and never appears at the destination.
        assert_eq!(
            moved, 2,
            "only the meetings files move (force_copy={force_copy})"
        );
        assert_eq!(
            fs::read(to.join("meetings/m1/audio.wav")).expect("read moved audio"),
            b"pcm-bytes",
            "meetings must move (force_copy={force_copy})"
        );
        assert!(
            to.join("meetings/m1/meeting.json").is_file(),
            "meetings must move (force_copy={force_copy})"
        );
        assert!(
            !from.join("meetings/m1/audio.wav").exists(),
            "moved meetings entries must leave the source (force_copy={force_copy})"
        );
        assert!(
            !to.join("models").exists(),
            "the destination must not gain a models/ dir (force_copy={force_copy})"
        );
        assert_eq!(
            fs::read(from.join("models/parakeet-tdt-0.6b-v3-int8/encoder.int8.onnx"))
                .expect("read source weights"),
            b"weights",
            "from/models must be left untouched (force_copy={force_copy})"
        );
    }
}

// --- storage change never moves models_root (regression) ------------------
//
// Acceptance: models live at the fixed `~/myna/models`; changing the
// Settings storage location and restarting must not prompt a re-download —
// `models_status` keeps reporting `all_present` at the fixed path.
// This pins that contract through the public seams: the effective data
// root follows the persisted pointer swap, `resolve_models_root` is
// identical before/after, and the migration leaves top-level `models/`
// behind (never materializing it at the destination).

#[test]
fn storage_change_does_not_move_models_root() {
    // Arrange: two distinct effective data roots standing in for `~/myna`
    // before a Settings storage change and a custom location after it.
    let sandbox = tempfile::tempdir().expect("tempdir");
    let config = sandbox.path().join("config");
    let before_root = sandbox.path().join("before-root");
    let after_root = sandbox.path().join("after-root");
    fs::create_dir_all(&before_root).expect("create before root");
    fs::create_dir_all(&after_root).expect("create after root");
    // A meetings archive plus a stray top-level `models/` weights dir at
    // the source, as a pre-skip migration would have left it.
    write_file(&before_root, "meetings/m1/audio.wav", b"pcm-bytes");
    write_file(
        &before_root,
        "models/parakeet-tdt-0.6b-v3-int8/encoder.int8.onnx",
        b"weights",
    );
    // A complete weights set standing in for the fixed `~/myna/models`:
    // this is where `models_status` must keep reporting `all_present`.
    let fixed_models = sandbox.path().join("fixed-models");
    for (dir_name, file) in [
        ("parakeet-tdt-0.6b-v3-int8", "encoder.int8.onnx"),
        ("parakeet-tdt-0.6b-v3-int8", "decoder.int8.onnx"),
        ("parakeet-tdt-0.6b-v3-int8", "joiner.int8.onnx"),
        ("parakeet-tdt-0.6b-v3-int8", "tokens.txt"),
        (
            "qwen2.5-7b-instruct",
            "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf",
        ),
        (
            "qwen2.5-7b-instruct",
            "qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf",
        ),
        ("silero-vad", "silero_vad.onnx"),
    ] {
        write_file(&fixed_models, &format!("{dir_name}/{file}"), b"weights");
    }

    StoragePrefs::new(Some(before_root.clone()))
        .save(&config)
        .expect("save pointer");
    let effective_before = effective_data_root(None, &config).expect("effective before");
    assert_eq!(effective_before, before_root);
    let models_before = resolve_models_root(None, false);

    // Act: simulated Settings storage change — the pointer now names the
    // custom location — plus the archive migration a move would run.
    StoragePrefs::new(Some(after_root.clone()))
        .save(&config)
        .expect("save pointer");
    let effective_after = effective_data_root(None, &config).expect("effective after");
    let models_after = resolve_models_root(None, false);
    let moved = migrate_data_root(&before_root, &after_root).expect("migrate");

    // Assert: the effective root followed the pointer swap, but the models
    // root is byte-identical and points at neither data root's `models/`.
    assert_eq!(effective_after, after_root);
    assert_ne!(
        effective_after, effective_before,
        "the pointer swap must actually change the effective data root"
    );
    assert_eq!(
        models_after, models_before,
        "changing the storage location must not move the models root"
    );
    assert_ne!(models_after, after_root.join("models"));
    assert_ne!(models_after, before_root.join("models"));
    // Only the meetings file moves; `models/` stays behind and never
    // appears at the destination.
    assert_eq!(moved, 1, "only the meetings file moves");
    assert!(
        !after_root.join("models").exists(),
        "the destination must not gain a models/ dir"
    );
    assert!(
        before_root
            .join("models/parakeet-tdt-0.6b-v3-int8/encoder.int8.onnx")
            .is_file(),
        "from/models must be left untouched"
    );
    // No download prompt after restart: status at the fixed location is
    // still `all_present`, while the custom root holds no usable weights.
    assert!(
        models_status_at(&fixed_models).all_present,
        "models_status at the fixed location must stay all_present across a storage change"
    );
    assert!(
        !models_status_at(&after_root.join("models")).all_present,
        "the custom location must never satisfy the presence gate on its own"
    );
}

// --- move_existing=false (stay) branch contract ----------------------------
//
// Stay (`set_storage_location(_, false)` / `reset_storage_location(false)`)
// never calls `migrate_data_root` on the live archive: it ensures the
// destination (`0700`) and saves/clears the pointer, leaving the source
// byte-identical with no merge into a non-empty destination. The stay
// branch shares its ensure-dest primitive (`create_dir_all_0700`, reached
// here through the missing-source arm), the pointer write
// (`StoragePrefs::save`), and every guard (pinned / busy / scope /
// validation) with the move path — these tests pin that contract through
// those public seams without booting Tauri.

#[test]
fn storage_stay_creates_missing_dest_leaves_source_byte_identical() {
    // Arrange: a populated source archive; the ensure call names a
    // missing `from` so only the ensure-dest arm runs — the same
    // `create_dir_all_0700` primitive the stay branch uses.
    let sandbox = tempfile::tempdir().expect("tempdir");
    let source = sandbox.path().join("source-root");
    write_file(&source, "meetings/m1/audio.wav", b"pcm-bytes-1234");
    write_file(&source, "meetings/m1/meeting.json", b"{}");
    let missing = sandbox.path().join("does-not-exist");
    let dest = sandbox.path().join("stay-root");

    // Act
    let moved = migrate_data_root(&missing, &dest).expect("ensure dest");

    // Assert: a usable empty root, zero moved, the source byte-identical.
    assert_eq!(moved, 0);
    assert!(dest.is_dir(), "stay must ensure a usable destination");
    assert_eq!(
        file_count(&dest),
        0,
        "stay must start empty — it never merges the source"
    );
    assert_eq!(
        fs::read(source.join("meetings/m1/audio.wav")).expect("read source"),
        b"pcm-bytes-1234",
        "stay must leave the source byte-identical"
    );
    assert_eq!(file_count(&source), 2);
}

#[test]
#[cfg(unix)]
fn storage_stay_missing_dest_is_0700() {
    use std::os::unix::fs::PermissionsExt;

    // Arrange
    let sandbox = tempfile::tempdir().expect("tempdir");
    let missing = sandbox.path().join("does-not-exist");
    let dest = sandbox.path().join("stay-root");

    // Act: the same ensure-dest primitive the stay branch uses.
    migrate_data_root(&missing, &dest).expect("ensure dest");

    // Assert: the at-rest policy applies to stay destinations too.
    let mode = fs::metadata(&dest).expect("metadata").permissions().mode() & 0o777;
    assert_eq!(mode, 0o700, "stay destinations must be 0700, got {mode:o}");
}

#[test]
fn storage_stay_does_not_merge_into_non_empty_dest() {
    // Arrange: source and destination both populated with different files.
    let sandbox = tempfile::tempdir().expect("tempdir");
    let source = sandbox.path().join("source-root");
    let dest = sandbox.path().join("stay-root");
    write_file(&source, "meetings/m1/source.wav", b"source-bytes");
    write_file(&dest, "meetings/m1/dest.wav", b"dest-bytes");
    let missing = sandbox.path().join("does-not-exist");

    // Act: stay ensures (idempotent over the existing dest) and saves the
    // pointer — it never migrates, so no merge runs.
    let moved = migrate_data_root(&missing, &dest).expect("ensure dest");
    let config = sandbox.path().join("config");
    StoragePrefs::new(Some(dest.clone()))
        .save(&config)
        .expect("save pointer");

    // Assert: neither side gained the other's file, neither lost its own.
    assert_eq!(moved, 0);
    assert_eq!(
        fs::read(dest.join("meetings/m1/dest.wav")).expect("read dest"),
        b"dest-bytes",
        "stay must never overwrite the destination"
    );
    assert!(
        !dest.join("meetings/m1/source.wav").exists(),
        "stay must never merge source entries into the destination"
    );
    assert_eq!(
        fs::read(source.join("meetings/m1/source.wav")).expect("read source"),
        b"source-bytes",
        "stay must leave the source in place"
    );
    assert_eq!(StoragePrefs::load(&config).data_dir(), Some(dest.as_path()));
}

#[test]
fn storage_stay_same_path_is_noop_zero_regardless_of_flag() {
    // Arrange: from == to must short-circuit before any branch — the flag
    // is ignored here, so stay and move agree.
    let sandbox = tempfile::tempdir().expect("tempdir");
    let root = sandbox.path().join("root");
    write_file(&root, "meetings/m1/audio.wav", b"pcm");

    // Act
    let moved = migrate_data_root(&root, &root).expect("migrate");

    // Assert
    assert_eq!(moved, 0);
    assert_eq!(
        fs::read(root.join("meetings/m1/audio.wav")).expect("read audio"),
        b"pcm",
        "from == to must leave the archive untouched on either branch"
    );
}

#[test]
fn storage_stay_still_refuses_pinned_busy_out_of_scope_and_unwritable() {
    // Arrange: pinned override, an import in flight, an out-of-scope
    // candidate, and a location naming an existing file.
    let dir = tempfile::tempdir().expect("tempdir");
    let state = fresh_state(dir.path());
    state.begin_import().expect("begin_import");
    let home = tempfile::tempdir().expect("tempdir");
    let elsewhere = tempfile::tempdir().expect("tempdir");
    let out_of_scope = elsewhere.path().join("archive");
    let sandbox = tempfile::tempdir().expect("tempdir");
    let not_a_dir = write_file(&sandbox.path().join("root"), "audio.wav", b"pcm");

    // Act / Assert: every guard runs before either branch, so stay refuses
    // exactly like move.
    assert_path_error(
        refuse_when_data_dir_pinned_with(Some(OsStr::new("/pinned/override"))),
        "stay while MYNA_DATA_DIR pinned",
    );
    assert_busy(state.guard_storage_change(), "stay while import in flight");
    assert!(
        !storage_path_in_scope(&out_of_scope, home.path(), &[]),
        "{} must be out of scope for stay too",
        out_of_scope.display()
    );
    assert_path_error(
        validate_storage_location(&not_a_dir),
        "stay naming an existing file",
    );
    assert_path_error(validate_storage_location(""), "stay with an empty path");
}
