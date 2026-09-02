//! Guards the privacy-minimal shape of `tauri.conf.json`'s
//! `plugins.updater` block. Endpoint templating (`{{target}}`, `{{arch}}`,
//! `{{current_version}}`, `{{bundle_type}}`) is deliberately unused: a
//! static manifest means every user fetches the byte-identical public
//! file and version comparison happens locally, so the request discloses
//! only IP + SNI — not version, arch, or any identifier. This test only
//! proves the config knob is set correctly; it cannot exercise the actual
//! network request.

use std::fs;
use std::path::PathBuf;

fn load_config() -> serde_json::Value {
    let config_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
    let raw = fs::read_to_string(&config_path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", config_path.display()));
    serde_json::from_str(&raw).expect("tauri.conf.json must be valid JSON")
}

#[test]
fn updater_pubkey_is_present_and_base64_decodes() {
    // Protects: the signature that guarantees a downloaded update actually
    // came from us, not a tampered/MITM'd artifact.
    let config = load_config();
    let pubkey = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .expect("plugins.updater.pubkey must be a string");
    assert!(
        !pubkey.is_empty(),
        "plugins.updater.pubkey must not be empty"
    );

    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(pubkey)
        .expect("plugins.updater.pubkey must be valid base64");
}

#[test]
fn updater_has_exactly_one_https_endpoint() {
    // Protects: a single, TLS-only source of truth for update manifests —
    // no plaintext fallback, no fan-out to multiple trust boundaries.
    let config = load_config();
    let endpoints = config["plugins"]["updater"]["endpoints"]
        .as_array()
        .expect("plugins.updater.endpoints must be an array");
    assert_eq!(
        endpoints.len(),
        1,
        "plugins.updater.endpoints must have exactly one entry, got {}",
        endpoints.len()
    );

    let endpoint = endpoints[0]
        .as_str()
        .expect("plugins.updater.endpoints[0] must be a string");
    let url = url::Url::parse(endpoint).expect("endpoint must be a valid URL");
    assert_eq!(
        url.scheme(),
        "https",
        "plugins.updater.endpoints[0] must use https, got scheme {:?}",
        url.scheme()
    );
}

#[test]
fn updater_endpoint_contains_no_fingerprinting_template_variables() {
    // Protects: the request must disclose only IP + SNI. Templating in
    // {{target}}/{{arch}}/{{current_version}}/{{bundle_type}} would leak
    // platform, architecture, and exact installed version to the server on
    // every check — a static manifest URL means every user fetches the
    // byte-identical public file and comparison happens locally.
    let config = load_config();
    let endpoint = config["plugins"]["updater"]["endpoints"][0]
        .as_str()
        .expect("plugins.updater.endpoints[0] must be a string");

    for forbidden in [
        "{{target}}",
        "{{arch}}",
        "{{current_version}}",
        "{{bundle_type}}",
    ] {
        assert!(
            !endpoint.contains(forbidden),
            "plugins.updater.endpoints[0] must not contain {forbidden:?} — \
             templating would leak platform/version identifiers to the server \
             on every check: {endpoint:?}"
        );
    }
}

#[test]
fn updater_does_not_opt_into_insecure_transport() {
    // Protects: no silent downgrade path to plaintext HTTP for update
    // manifests or artifacts.
    let config = load_config();
    assert!(
        config["plugins"]["updater"]["dangerousInsecureTransportProtocol"].is_null(),
        "plugins.updater.dangerousInsecureTransportProtocol must be absent — \
         its presence would allow downgrading the updater to plaintext HTTP"
    );
}

#[test]
fn bundle_creates_updater_artifacts() {
    // Protects: without this, no signed/verifiable release manifest is
    // ever produced, so `check_for_update` would have nothing genuine to
    // verify against — a functional prerequisite of the whole feature.
    let config = load_config();
    assert_eq!(
        config["bundle"]["createUpdaterArtifacts"],
        serde_json::json!(true),
        "bundle.createUpdaterArtifacts must be true"
    );
}
