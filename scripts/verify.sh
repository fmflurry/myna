#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"

# Resolve repo root from this script's location so it can be invoked from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

echo "==> cargo fmt --all --check"
cargo fmt --all --check

echo "==> cargo clippy --workspace --all-targets --locked -- -D warnings"
cargo clippy --workspace --all-targets --locked -- -D warnings

echo "==> cargo build --workspace --locked"
cargo build --workspace --locked

echo "==> cargo test --workspace --locked"
cargo test --workspace --locked

# --- UI (Angular) verification placeholder -------------------------------
# When ui/ is scaffolded, add: (cd ui && npm ci && npm run lint && npm run build && npm test)

# --- Tauri (app/) verification placeholder --------------------------------
# When app/ is scaffolded, add: (cd app && cargo tauri build --debug) or equivalent check

echo "==> verify.sh: all checks passed"
