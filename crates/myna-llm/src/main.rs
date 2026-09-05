//! `myna-llm` CLI: renders a summary template against a transcript and
//! streams the model's response to stdout.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use myna_llm::{RenderContext, Summarizer, SummaryOptions, Template};

#[derive(Debug, Parser)]
#[command(name = "myna-llm", about = "Local summarization for Myna transcripts")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Render a summary template against a transcript and run inference.
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
        language: Option<String>,
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

/// CLI-supplied overrides layered onto [`SummaryOptions::default`].
struct SummaryOverrides {
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    top_p: Option<f32>,
    seed: Option<u32>,
    n_ctx: Option<u32>,
}

fn apply_overrides(overrides: SummaryOverrides) -> SummaryOptions {
    let defaults = SummaryOptions::default();
    SummaryOptions {
        n_ctx: overrides.n_ctx.unwrap_or(defaults.n_ctx),
        max_tokens: overrides.max_tokens.unwrap_or(defaults.max_tokens),
        temperature: overrides.temperature.unwrap_or(defaults.temperature),
        top_p: overrides.top_p.unwrap_or(defaults.top_p),
        seed: overrides.seed.unwrap_or(defaults.seed),
        n_threads: defaults.n_threads,
    }
}

fn main() -> Result<()> {
    // Must run before any model is loaded (and before any other thread
    // starts) — see `myna_llm::init_ggml_env` docs for why: it prevents a
    // deterministic `abort()` on process exit once ggml's Metal device has
    // registered weight buffers.
    myna_llm::init_ggml_env();

    let Command::Summarize {
        model,
        template,
        transcript,
        title,
        duration,
        language,
        max_tokens,
        temperature,
        top_p,
        seed,
        n_ctx,
    } = Cli::parse().command;

    let template = Template::load(&template)
        .with_context(|| format!("loading template {}", template.display()))?;
    let ctx = build_render_context(&transcript, title, duration, language)?;
    let opts = apply_overrides(SummaryOverrides {
        max_tokens,
        temperature,
        top_p,
        seed,
        n_ctx,
    });

    let summarizer =
        Summarizer::load(&model).with_context(|| format!("loading model {}", model.display()))?;

    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_handler = Arc::clone(&cancel);
    ctrlc::set_handler(move || cancel_handler.store(true, Ordering::SeqCst))
        .context("installing Ctrl-C handler")?;

    let on_token = |piece: &str| {
        print!("{piece}");
        let _ = std::io::stdout().flush();
    };

    // `summarize_transcript` (not the lower-level `summarize`) so a long
    // transcript that doesn't fit `opts.n_ctx` in one prompt transparently
    // falls back to map-reduce chunking instead of aborting llama.cpp.
    summarizer
        .summarize_transcript(&template, &ctx, &opts, &cancel, on_token)
        .context("running summarization")?;
    println!();

    Ok(())
}

/// Read `transcript_path` and build the render context for the requested
/// `language` (falling back to the default when `None` or unrecognized —
/// see `myna_llm::resolve`). The template itself is loaded separately by
/// the caller and rendered later, inside `summarize_transcript`.
fn build_render_context(
    transcript_path: &Path,
    title: Option<String>,
    duration: Option<String>,
    language: Option<String>,
) -> Result<RenderContext> {
    let transcript = fs::read_to_string(transcript_path)
        .with_context(|| format!("reading transcript {}", transcript_path.display()))?;

    let (_, language_label) = myna_llm::resolve(language.as_deref());
    Ok(RenderContext {
        transcript,
        duration: duration.unwrap_or_default(),
        title: title.unwrap_or_default(),
        language: language_label.to_string(),
        // The CLI exposes no instruction flags yet; user instructions are a
        // GUI (Phase 2) concern.
        instructions: None,
    })
}
