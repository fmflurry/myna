#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Must run before any Metal buffer is allocated (i.e. before the first
    // `Summarizer::load`) -- see `myna_llm::init_ggml_env`'s doc comment for
    // why. Called here, at the single-threaded startup point, so the env
    // var is set before any thread could race a concurrent `set_var`;
    // `Summarizer::load` also calls it itself, but the `Once` guard makes
    // that later call a no-op.
    myna_llm::init_ggml_env();
    myna_app::run()
}
