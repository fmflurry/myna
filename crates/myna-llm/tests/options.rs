//! Pure argument/option tests for the `myna-llm` CLI and `SummaryOptions`.
//!
//! These tests never load a model: they only assert default values and
//! that CLI flags parse and map onto the correct [`SummaryOptions`] fields.

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use myna_llm::SummaryOptions;

const DEFAULT_N_CTX: u32 = 32_768;
const DEFAULT_MAX_TOKENS: u32 = 1024;
const DEFAULT_TEMPERATURE: f32 = 0.3;
const DEFAULT_TOP_P: f32 = 0.9;
const DEFAULT_SEED: u32 = 1234;
const DEFAULT_N_THREADS: i32 = 0;

/// Mirrors the `myna-llm` binary's CLI surface so this test crate does not
/// need to depend on the `[[bin]]` target directly.
#[derive(Debug, Parser)]
#[command(name = "myna-llm")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Summarize {
        #[arg(long)]
        model: PathBuf,
        #[arg(long)]
        template: PathBuf,
        #[arg(long)]
        transcript: PathBuf,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        duration: Option<String>,
        #[arg(long)]
        max_tokens: Option<u32>,
        #[arg(long)]
        temperature: Option<f32>,
        #[arg(long)]
        top_p: Option<f32>,
        #[arg(long)]
        seed: Option<u32>,
        #[arg(long)]
        n_ctx: Option<u32>,
    },
}

#[test]
fn default_summary_options_match_documented_values() {
    let opts = SummaryOptions::default();

    assert_eq!(opts.n_ctx, DEFAULT_N_CTX);
    assert_eq!(opts.max_tokens, DEFAULT_MAX_TOKENS);
    assert_eq!(opts.temperature, DEFAULT_TEMPERATURE);
    assert_eq!(opts.top_p, DEFAULT_TOP_P);
    assert_eq!(opts.seed, DEFAULT_SEED);
    assert_eq!(opts.n_threads, DEFAULT_N_THREADS);
}

#[test]
fn cli_accepts_the_documented_summarize_command() {
    let cli = Cli::try_parse_from([
        "myna-llm",
        "summarize",
        "--model",
        "model.gguf",
        "--template",
        "templates/key-points.json",
        "--transcript",
        "transcript.txt",
    ])
    .expect("documented command line must parse");

    let Command::Summarize {
        model,
        template,
        transcript,
        title,
        duration,
        max_tokens,
        temperature,
        top_p,
        seed,
        n_ctx,
    } = cli.command;

    assert_eq!(model, PathBuf::from("model.gguf"));
    assert_eq!(template, PathBuf::from("templates/key-points.json"));
    assert_eq!(transcript, PathBuf::from("transcript.txt"));
    assert_eq!(title, None);
    assert_eq!(duration, None);
    assert_eq!(max_tokens, None);
    assert_eq!(temperature, None);
    assert_eq!(top_p, None);
    assert_eq!(seed, None);
    assert_eq!(n_ctx, None);
}

#[test]
fn cli_flag_overrides_map_onto_the_correct_fields() {
    let cli = Cli::try_parse_from([
        "myna-llm",
        "summarize",
        "--model",
        "model.gguf",
        "--template",
        "templates/key-points.json",
        "--transcript",
        "transcript.txt",
        "--title",
        "Standup",
        "--duration",
        "15m",
        "--max-tokens",
        "64",
        "--temperature",
        "0.7",
        "--top-p",
        "0.95",
        "--seed",
        "42",
        "--n-ctx",
        "8192",
    ])
    .expect("overridden command line must parse");

    let Command::Summarize {
        title,
        duration,
        max_tokens,
        temperature,
        top_p,
        seed,
        n_ctx,
        ..
    } = cli.command;

    assert_eq!(title, Some("Standup".to_string()));
    assert_eq!(duration, Some("15m".to_string()));
    assert_eq!(max_tokens, Some(64));
    assert_eq!(temperature, Some(0.7));
    assert_eq!(top_p, Some(0.95));
    assert_eq!(seed, Some(42));
    assert_eq!(n_ctx, Some(8192));
}
