//! Regression test for `link_ollama_qwen` in `scripts/download-models.sh`:
//! resolving an Ollama manifest -> model-layer blob -> symlink, without
//! touching the network (`--only qwen` short-circuits before any `curl`).
#![cfg(unix)]

use std::fs::{self, File};
use std::path::Path;
use std::process::Command;

/// 64 lowercase hex chars, matching the `sha256:[0-9a-f]{64}` the script's
/// manifest scan expects.
const MODEL_DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONFIG_DIGEST: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[test]
fn link_ollama_qwen_resolves_manifest_to_blob_symlink() {
    // Arrange: fake Ollama models root with a manifest that has two layers
    // (a config layer and the model layer) so the script must pick the
    // right one by media type, not just "the first layer".
    let ollama_root = tempfile::tempdir().expect("ollama root tempdir");
    let blob_path = ollama_root
        .path()
        .join("blobs")
        .join(format!("sha256-{MODEL_DIGEST}"));
    fs::create_dir_all(blob_path.parent().expect("parent dir")).expect("create blobs dir");
    // Sparse file: instant, no real 1 GiB written. The script's size guard
    // only checks `wc -c` (apparent size), which reports the full length.
    File::create(&blob_path)
        .expect("create blob")
        .set_len(1024 * 1024 * 1024)
        .expect("set blob length");

    let manifest_dir = ollama_root
        .path()
        .join("manifests/registry.ollama.ai/library/qwen2.5");
    fs::create_dir_all(&manifest_dir).expect("create manifest dir");
    let manifest = format!(
        r#"{{"schemaVersion":2,"config":{{"mediaType":"application/vnd.ollama.image.config","digest":"sha256:{CONFIG_DIGEST}","size":100}},"layers":[{{"mediaType":"application/vnd.ollama.image.config","digest":"sha256:{CONFIG_DIGEST}","size":200}},{{"mediaType":"application/vnd.ollama.image.model","digest":"sha256:{MODEL_DIGEST}","size":1234}}]}}"#
    );
    fs::write(manifest_dir.join("7b-instruct"), manifest).expect("write manifest");

    let dest = tempfile::tempdir().expect("dest tempdir");
    let home = tempfile::tempdir().expect("home tempdir");
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let script = repo_root.join("scripts/download-models.sh");

    // Act
    let output = Command::new("bash")
        .arg(&script)
        .arg("--dest")
        .arg(dest.path())
        .arg("--only")
        .arg("qwen")
        .env("OLLAMA_MODELS", ollama_root.path())
        .env("HOME", home.path())
        .output()
        .expect("run download-models.sh");

    // Assert
    assert!(
        output.status.success(),
        "script failed: stdout={}\nstderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let link = dest
        .path()
        .join("qwen2.5-7b-instruct")
        .join("qwen2.5-7b-instruct-q4_k_m.gguf");
    let metadata = fs::symlink_metadata(&link).expect("link exists");
    assert!(metadata.file_type().is_symlink(), "expected a symlink");
    assert_eq!(
        fs::canonicalize(&link).expect("canonicalize link"),
        fs::canonicalize(&blob_path).expect("canonicalize blob"),
        "symlink must resolve to the manifest's model-layer blob"
    );
}
