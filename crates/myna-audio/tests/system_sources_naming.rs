//! Deterministic, non-live acceptance tests for [`list_system_audio_sources`]'s
//! naming and grouping behaviour.
//!
//! Unlike `system_macos_live.rs`, these never open a tap or require any
//! permission: [`AudioProcess::list`]-backed enumeration is a plain HAL
//! property read, not gated by `kTCCServiceAudioCapture`, so it's safe to
//! call unconditionally in CI. They run against whatever processes happen to
//! be on the machine, so assertions are limited to invariants that must hold
//! regardless of which apps are running.

use myna_audio::{default_output_device, list_system_audio_sources, ALL_OUTPUT_SOURCE_ID};

/// A raw identifier the picker must never surface as a display name — see
/// `myna_audio::system_macos::looks_like_identifier` (private; this is the
/// external contract it enforces).
fn looks_like_a_raw_identifier(name: &str) -> bool {
    name.starts_with("com.")
        || name.starts_with("org.")
        || name.starts_with("net.")
        || name.starts_with("pid:")
        || name.starts_with("pid ")
        || name.chars().all(|character| character.is_ascii_digit())
}

#[test]
fn all_output_source_is_always_first() {
    let sources = list_system_audio_sources();

    assert_eq!(
        sources.first().map(|source| source.id.as_str()),
        Some(ALL_OUTPUT_SOURCE_ID)
    );
}

/// Spec change: the all-output entry is labelled after the host's default
/// output device — `Default system (<device name>)` — so the picker shows
/// which hardware the capture follows. The generic `All system audio` name
/// is only the fallback for a machine with no default output device.
/// Asserting the composed form (on any machine that has a default output
/// device) fails against the old always-generic naming.
#[test]
fn all_output_source_is_named_after_the_default_output_device() {
    let sources = list_system_audio_sources();
    let all_output = sources.first().expect("all-output source is always first");

    match default_output_device() {
        Ok(device) => {
            assert_eq!(all_output.name, format!("Default system ({})", device.name));
        }
        Err(_) => {
            assert_eq!(all_output.name, "All system audio");
        }
    }
}

#[test]
fn no_source_name_looks_like_a_raw_identifier() {
    let sources = list_system_audio_sources();

    for source in &sources {
        assert!(
            !looks_like_a_raw_identifier(&source.name),
            "source {:?} has a machine-shaped name: {:?}",
            source.id,
            source.name
        );
    }
}

#[test]
fn application_sources_are_sorted_alphabetically_case_insensitively_after_all_output() {
    let sources = list_system_audio_sources();
    let application_names: Vec<String> = sources
        .iter()
        .skip(1)
        .map(|source| source.name.to_lowercase())
        .collect();

    let mut sorted = application_names.clone();
    sorted.sort();

    assert_eq!(application_names, sorted);
}

#[test]
fn current_process_is_never_listed_as_a_source() {
    let current_pid = std::process::id();
    let pid_source_id = format!("app:pid:{current_pid}");

    let sources = list_system_audio_sources();

    assert!(
        sources.iter().all(|source| source.id != pid_source_id),
        "current process (pid {current_pid}) must never appear as a capturable source"
    );
}
