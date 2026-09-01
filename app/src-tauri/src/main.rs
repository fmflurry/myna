#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Must run before any model is loaded (and before any other thread
    // starts) — see `myna_llm::init_ggml_env` docs for why: it prevents a
    // deterministic `abort()` on ⌘Q once ggml's Metal device has
    // registered weight buffers.
    myna_llm::init_ggml_env();
    myna_app::run()
}
