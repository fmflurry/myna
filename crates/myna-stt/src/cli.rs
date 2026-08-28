//! Command-line argument parsing for the `myna-stt` binary.
//!
//! Kept in the library so it can be exercised by integration tests without
//! spawning a process.

use std::ffi::OsString;
use std::path::PathBuf;

use clap::builder::PossibleValuesParser;
use clap::Parser;

use crate::engine::{ALLOWED_DECODING_METHODS, DEFAULT_BLANK_PENALTY};

/// Default Silero VAD model path, relative to the current working directory.
pub const DEFAULT_VAD_MODEL: &str = "models/silero-vad/silero_vad.onnx";

/// `myna-stt` command-line arguments.
#[derive(Parser, Debug, Clone)]
#[command(about = "Offline Parakeet-TDT decode and simulated streaming STT")]
pub struct Cli {
    /// Directory containing the Parakeet-TDT model artifacts.
    #[arg(long)]
    pub model: PathBuf,

    /// A WAV file path, or `mic` to stream from the default input device.
    #[arg(long)]
    pub input: String,

    /// Stream from the microphone instead of decoding a WAV file offline.
    #[arg(long)]
    pub stream: bool,

    /// Silero VAD model path (defaults to [`DEFAULT_VAD_MODEL`]).
    #[arg(long = "vad-model")]
    pub vad_model: Option<PathBuf>,

    /// `sherpa_onnx::OfflineRecognizerConfig::blank_penalty`. Positive
    /// values reduce deletions (dropped words) at the cost of some
    /// insertions; negative values are silently ignored by sherpa-onnx.
    #[arg(long, default_value_t = DEFAULT_BLANK_PENALTY)]
    pub blank_penalty: f32,

    /// Decoding method: `greedy_search` (default) or
    /// `modified_beam_search`. Restricted to a fixed allowlist — an
    /// unrecognized value passed to sherpa-onnx kills the process instead
    /// of returning an error.
    #[arg(long, value_parser = PossibleValuesParser::new(ALLOWED_DECODING_METHODS))]
    pub decoding_method: Option<String>,
}

impl Cli {
    /// Parses `args`, rejecting `--stream` combined with a non-`mic` input
    /// and `--input mic` without `--stream`.
    pub fn try_parse_from<I, T>(args: I) -> Result<Self, clap::Error>
    where
        I: IntoIterator<Item = T>,
        T: Into<OsString> + Clone,
    {
        let cli = <Self as clap::Parser>::try_parse_from(args)?;
        cli.validate()?;
        Ok(cli)
    }

    /// Resolves the Silero VAD model path, falling back to
    /// [`DEFAULT_VAD_MODEL`] when unset.
    pub fn vad_model_path(&self) -> PathBuf {
        self.vad_model
            .clone()
            .unwrap_or_else(|| PathBuf::from(DEFAULT_VAD_MODEL))
    }

    fn validate(&self) -> Result<(), clap::Error> {
        use clap::error::ErrorKind;

        if self.stream && self.input != "mic" {
            return Err(clap::Error::raw(
                ErrorKind::ArgumentConflict,
                "--stream requires --input mic\n",
            ));
        }
        if !self.stream && self.input == "mic" {
            return Err(clap::Error::raw(
                ErrorKind::ArgumentConflict,
                "--input mic requires --stream\n",
            ));
        }
        Ok(())
    }
}
