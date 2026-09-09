//! Effective data-root resolution + storage-location validation + pointer
//! round-trip, exercised against `tempfile::tempdir()`.
//!
//! No test in this file touches the real `~/myna`, mutates process-global
//! environment state (`std::env::set_var`/`remove_var` require `unsafe`,
//! forbidden workspace-wide), or boots Tauri: [`effective_data_root`] takes
//! its `MYNA_DATA_DIR` override and config dir as explicit parameters, and
//! [`StoragePrefs::load`] never fails — so the corrupt/missing-pointer
//! fallback is pinned at the load layer (unset pointer) without ever
//! invoking the `~/myna` default branch, which would create the real
//! directory on disk.
//!
//! Every test fn is named `storage_*` so
//! `cargo test -p myna-app storage` executes this whole file.

use std::fs;

use myna_app::commands::storage::storage_path_in_scope;
use myna_app::error::AppError;
use myna_app::paths::{effective_data_root, validate_storage_location, PathError};
use myna_app::storage_prefs::StoragePrefs;

/// Asserts `result` is the [`AppError::Path`] rejection the validator and
/// the storage edge promise (never `Io`/`Store`/a success).
fn assert_path_rejection(result: Result<(), AppError>, case: &str) {
    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::Path(_)),
        "expected AppError::Path for {case}, got {err:?}"
    );
}

#[test]
fn storage_override_wins_over_persisted_pointer() {
    // Arrange: a config dir whose pointer names dir A, plus a separate
    // override dir B standing in for `MYNA_DATA_DIR`.
    let config = tempfile::tempdir().expect("tempdir");
    let pointed = tempfile::tempdir().expect("tempdir");
    StoragePrefs::new(Some(pointed.path().to_path_buf()))
        .save(config.path())
        .expect("save pointer");
    let override_dir = tempfile::tempdir().expect("tempdir");

    // Act
    let resolved = effective_data_root(Some(override_dir.path().to_path_buf()), config.path())
        .expect("effective root");

    // Assert: the override wins — env > pointer.
    assert_eq!(resolved, override_dir.path());
}

#[test]
fn storage_override_wins_over_corrupt_pointer() {
    // Arrange: a config dir with garbage in both pointer layouts, plus an
    // override dir standing in for `MYNA_DATA_DIR`.
    let config = tempfile::tempdir().expect("tempdir");
    fs::write(config.path().join("storage.json"), b"{not json").expect("write corrupt pointer");
    let override_dir = tempfile::tempdir().expect("tempdir");

    // Act
    let resolved = effective_data_root(Some(override_dir.path().to_path_buf()), config.path())
        .expect("effective root");

    // Assert: corrupt pointer degrades to unset, override still wins.
    assert_eq!(resolved, override_dir.path());
}

#[test]
fn storage_pointer_honored_when_no_override() {
    // Arrange: a saved pointer, no override.
    let config = tempfile::tempdir().expect("tempdir");
    let pointed = tempfile::tempdir().expect("tempdir");
    StoragePrefs::new(Some(pointed.path().to_path_buf()))
        .save(config.path())
        .expect("save pointer");

    // Act
    let resolved = effective_data_root(None, config.path()).expect("effective root");

    // Assert: pointer > ~/myna default (default branch never consulted —
    // the real home directory is untouched).
    assert_eq!(resolved, pointed.path());
}

#[test]
fn storage_missing_pointer_loads_as_unset() {
    // Arrange: a config dir with no pointer files at all, plus a config
    // path that is a file rather than a directory (unreadable-as-dir).
    let config = tempfile::tempdir().expect("tempdir");
    let not_a_dir = config.path().join("not-a-dir");
    fs::write(&not_a_dir, b"{}").expect("write file");

    // Act / Assert: every missing/unreadable shape loads as unset, which
    // is what lets `effective_data_root` fall through to the default.
    assert_eq!(StoragePrefs::load(config.path()), StoragePrefs::default());
    assert_eq!(StoragePrefs::load(&not_a_dir), StoragePrefs::default());
}

#[test]
fn storage_corrupt_pointer_loads_as_unset() {
    // Arrange: pointer files that are unparseable or the wrong shape.
    for raw in [
        b"{not json".as_slice(),
        b"[1, 2, 3]".as_slice(),
        b"\"just a string\"".as_slice(),
        b"{\"data_dir\": 42}".as_slice(),
    ] {
        let config = tempfile::tempdir().expect("tempdir");
        fs::write(config.path().join("storage.json"), raw).expect("write corrupt pointer");

        // Act / Assert: load never fails — corrupt means "no pointer".
        assert_eq!(
            StoragePrefs::load(config.path()),
            StoragePrefs::default(),
            "raw pointer {raw:?} should load as unset"
        );
    }
}

#[test]
fn storage_pointer_round_trip_through_save_and_load() {
    // Arrange
    let config = tempfile::tempdir().expect("tempdir");
    let pointed = tempfile::tempdir().expect("tempdir");
    let prefs = StoragePrefs::new(Some(pointed.path().to_path_buf()));

    // Act
    prefs.save(config.path()).expect("save pointer");

    // Assert
    assert_eq!(StoragePrefs::load(config.path()), prefs);
}

#[test]
fn storage_save_preserves_unrelated_keys() {
    // Arrange: a pointer file that already holds unrelated keys (forward
    // compat — a future Myna version's settings must survive our save).
    let config = tempfile::tempdir().expect("tempdir");
    fs::write(
        config.path().join("storage.json"),
        br#"{"unrelated": 42, "data_dir": "/old"}"#,
    )
    .expect("write pointer");
    let pointed = tempfile::tempdir().expect("tempdir");

    // Act
    StoragePrefs::new(Some(pointed.path().to_path_buf()))
        .save(config.path())
        .expect("save pointer");

    // Assert: the pointer is updated and the unrelated key survives.
    let raw = fs::read_to_string(config.path().join("storage.json")).expect("read pointer");
    assert!(
        raw.contains("unrelated"),
        "unrelated keys must survive a save, got: {raw}"
    );
    assert!(
        raw.contains(&pointed.path().to_string_lossy().into_owned()),
        "saved pointer must be updated, got: {raw}"
    );
    assert_eq!(
        StoragePrefs::load(config.path()).data_dir(),
        Some(pointed.path())
    );
}

#[test]
#[cfg(unix)]
fn storage_save_writes_pointer_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    // Arrange
    let config = tempfile::tempdir().expect("tempdir");
    let pointed = tempfile::tempdir().expect("tempdir");

    // Act
    StoragePrefs::new(Some(pointed.path().to_path_buf()))
        .save(config.path())
        .expect("save pointer");

    // Assert: exactly 0600 — the pointer names the whole archive, so it
    // never gets a world- or group-readable window.
    let mode = fs::metadata(config.path().join("storage.json"))
        .expect("metadata")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(
        mode, 0o600,
        "expected storage.json to be 0600, got {mode:o}"
    );
}

#[test]
fn storage_save_with_none_clears_pointer() {
    // Arrange: a saved pointer.
    let config = tempfile::tempdir().expect("tempdir");
    let pointed = tempfile::tempdir().expect("tempdir");
    StoragePrefs::new(Some(pointed.path().to_path_buf()))
        .save(config.path())
        .expect("save pointer");

    // Act: saving `None` removes the key instead of writing null.
    StoragePrefs::new(None)
        .save(config.path())
        .expect("clear pointer");

    // Assert
    assert_eq!(StoragePrefs::load(config.path()), StoragePrefs::default());
    let raw = fs::read_to_string(config.path().join("storage.json")).expect("read pointer");
    assert!(
        !raw.contains("data_dir"),
        "cleared pointer file must not name a directory, got: {raw}"
    );
}

#[test]
fn storage_pointer_load_accepts_alias_key() {
    // Arrange: a pointer written under an alternate key name.
    let config = tempfile::tempdir().expect("tempdir");
    let pointed = tempfile::tempdir().expect("tempdir");
    let raw = format!("{{\"location\": \"{}\"}}", pointed.path().to_string_lossy());
    fs::write(config.path().join("storage.json"), raw).expect("write pointer");

    // Act / Assert
    assert_eq!(
        StoragePrefs::load(config.path()).data_dir(),
        Some(pointed.path())
    );
}

#[test]
fn storage_pointer_loads_from_namespaced_preferences_layout() {
    // Arrange: the shared-preferences layout (`preferences.json` under the
    // `"storage"` key), with no dedicated `storage.json` present.
    let config = tempfile::tempdir().expect("tempdir");
    let pointed = tempfile::tempdir().expect("tempdir");
    let raw = format!(
        "{{\"storage\": {{\"data_dir\": \"{}\"}}}}",
        pointed.path().to_string_lossy()
    );
    fs::write(config.path().join("preferences.json"), raw).expect("write preferences");

    // Act / Assert: either layout is honoured on load.
    assert_eq!(
        StoragePrefs::load(config.path()).data_dir(),
        Some(pointed.path())
    );
}

#[test]
fn storage_validator_rejects_file_not_dir() {
    // Arrange: an existing regular file where a data root should be.
    let dir = tempfile::tempdir().expect("tempdir");
    let file = dir.path().join("not-a-dir");
    fs::write(&file, b"pcm").expect("write file");

    // Act / Assert
    assert_path_rejection(validate_storage_location(&file), "existing file");
}

#[test]
fn storage_validator_rejects_empty_path() {
    // Act / Assert
    assert_path_rejection(validate_storage_location(""), "empty path");
}

#[test]
#[cfg(unix)]
fn storage_validator_rejects_symlink_location_and_symlinked_ancestor() {
    use std::os::unix::fs::symlink;

    // Arrange: a real dir, a symlink pointing at it (the escape: the link
    // could equally point outside the chosen location), and a not-yet-
    // existing path nested under the symlinked dir.
    let dir = tempfile::tempdir().expect("tempdir");
    let real = dir.path().join("real");
    fs::create_dir_all(&real).expect("create real dir");
    let link = dir.path().join("link");
    symlink(&real, &link).expect("create symlink");

    // Act / Assert: the link itself is rejected …
    assert_path_rejection(validate_storage_location(&link), "symlink itself");
    // … and so is a future data root nested under it (its nearest
    // existing ancestor is the symlink, which would redirect the whole
    // archive wherever the link points).
    assert_path_rejection(
        validate_storage_location(link.join("future-root")),
        "path under symlinked ancestor",
    );
}

#[test]
#[cfg(unix)]
fn storage_validator_rejects_unwritable_location() {
    use std::os::unix::fs::PermissionsExt;

    // Arrange: a directory without the owner write bit (rejected by the
    // mode check even for privileged users, before any probe write), plus
    // a not-yet-existing path that would be created under it.
    let dir = tempfile::tempdir().expect("tempdir");
    let readonly = dir.path().join("readonly");
    fs::create_dir_all(&readonly).expect("create dir");
    fs::set_permissions(&readonly, fs::Permissions::from_mode(0o555)).expect("chmod");

    // Act / Assert
    assert_path_rejection(validate_storage_location(&readonly), "unwritable dir");
    assert_path_rejection(
        validate_storage_location(readonly.join("future-root")),
        "nested path under unwritable ancestor",
    );
}

#[test]
fn storage_validator_accepts_existing_and_nested_missing_dirs() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");

    // Act / Assert: an existing writable dir is accepted …
    validate_storage_location(dir.path()).expect("existing dir should validate");
    // … and so is a not-yet-existing path under it (created later by
    // `effective_data_root`, not by validation).
    validate_storage_location(dir.path().join("future-root").join("nested"))
        .expect("nested missing path should validate");
    // Validation is side-effect-free apart from its short-lived probe:
    // no probe file and no created directories remain.
    assert!(
        !dir.path().join(".myna-write-probe").exists(),
        "probe file must be removed after validation"
    );
    assert!(
        !dir.path().join("future-root").exists(),
        "validation must not create the candidate path"
    );
}

#[test]
fn storage_validator_accepts_icloud_style_nested_path() {
    // Arrange: an iCloud Drive-style nested location (`~/Library/Mobile
    // Documents/…`, including the space in `Mobile Documents`) that does
    // not exist yet — notably this must NOT be rejected the way
    // save-dialog destinations under `~/Library` are.
    let dir = tempfile::tempdir().expect("tempdir");
    let icloud = dir
        .path()
        .join("Library")
        .join("Mobile Documents")
        .join("com~apple~CloudDocs")
        .join("myna");

    // Act / Assert
    validate_storage_location(&icloud).expect("iCloud-style nested path should validate");
}

#[test]
fn storage_missing_pointed_dir_fails_loudly() {
    // Arrange: a pointer naming a path that no longer exists (unplugged
    // drive, deleted folder, revoked iCloud grant).
    let config = tempfile::tempdir().expect("tempdir");
    let sandbox = tempfile::tempdir().expect("tempdir");
    let pointed = sandbox.path().join("future-root");
    StoragePrefs::new(Some(pointed.clone()))
        .save(config.path())
        .expect("save pointer");

    // Act
    let result = effective_data_root(None, config.path());

    // Assert: a loud `StorageMissing` error — never a silent recreate and
    // never a fall-through to the default (either would split the library
    // across two roots). Nothing is created at the pointed path.
    let err = result.unwrap_err();
    assert!(
        matches!(err, PathError::StorageMissing { .. }),
        "expected PathError::StorageMissing for a missing pointed dir, got {err:?}"
    );
    assert!(
        !pointed.exists(),
        "a missing pointed dir must not be recreated"
    );
}

#[test]
fn storage_scope_helper_accepts_home_myna_and_mobile_documents() {
    // Arrange: a tempdir standing in for $HOME.
    let home = tempfile::tempdir().expect("tempdir");

    // Act / Assert: both first-party roots are in scope without any extra
    // app-data/resource dirs.
    assert!(storage_path_in_scope(
        &home.path().join("myna").join("archive"),
        home.path(),
        &[]
    ));
    assert!(storage_path_in_scope(
        &home
            .path()
            .join("Library")
            .join("Mobile Documents")
            .join("com~apple~CloudDocs")
            .join("myna"),
        home.path(),
        &[]
    ));
}

#[test]
fn storage_scope_helper_rejects_paths_outside_all_roots() {
    // Arrange
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

#[test]
fn storage_scope_helper_accepts_extra_roots() {
    // Arrange: an app-data dir passed as an extra root.
    let home = tempfile::tempdir().expect("tempdir");
    let app_data = tempfile::tempdir().expect("tempdir");

    // Act / Assert
    assert!(storage_path_in_scope(
        &app_data.path().join("meetings"),
        home.path(),
        &[app_data.path().to_path_buf()]
    ));
    assert!(
        !storage_path_in_scope(&app_data.path().join("meetings"), home.path(), &[]),
        "without the extra root the same path must be out of scope"
    );
}
