//! Inference engine over the safe `llama-cpp-2` wrapper: model loading,
//! chat-template formatting, prefill, and streaming token generation.

use std::num::NonZeroU32;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use encoding_rs::Decoder;
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaChatMessage, LlamaChatTemplate, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::LlamaToken;

use crate::error::LlmError;

/// Default context window, in tokens.
const DEFAULT_N_CTX: u32 = 32_768;
/// Default maximum number of tokens generated per summary.
const DEFAULT_MAX_TOKENS: u32 = 1024;
/// Default sampling temperature.
const DEFAULT_TEMPERATURE: f32 = 0.3;
/// Default nucleus-sampling probability mass.
const DEFAULT_TOP_P: f32 = 0.9;
/// Default sampling seed.
const DEFAULT_SEED: u32 = 1234;
/// Default thread count; `0` lets llama.cpp pick automatically.
const DEFAULT_N_THREADS: i32 = 0;
/// `min_keep` for the top-p filter: never trim below this many candidates.
const TOP_P_MIN_KEEP: usize = 1;
/// Batch sequence id used for the single-sequence prefill/decode loop.
const SEQUENCE_ID: i32 = 0;
/// Chat template name used when the GGUF has none baked in.
const FALLBACK_CHAT_TEMPLATE: &str = "chatml";

/// Tunable generation parameters for [`Summarizer::summarize`].
#[derive(Debug, Clone)]
pub struct SummaryOptions {
    pub n_ctx: u32,
    pub max_tokens: u32,
    pub temperature: f32,
    pub top_p: f32,
    pub seed: u32,
    pub n_threads: i32,
}

impl Default for SummaryOptions {
    fn default() -> Self {
        Self {
            n_ctx: DEFAULT_N_CTX,
            max_tokens: DEFAULT_MAX_TOKENS,
            temperature: DEFAULT_TEMPERATURE,
            top_p: DEFAULT_TOP_P,
            seed: DEFAULT_SEED,
            n_threads: DEFAULT_N_THREADS,
        }
    }
}

/// A loaded Qwen (or any GGUF chat) model ready to summarize prompts.
pub struct Summarizer {
    backend: LlamaBackend,
    model: LlamaModel,
}

impl Summarizer {
    /// Load `model_path` into llama.cpp.
    ///
    /// Returns [`LlmError::ModelNotFound`] before touching llama.cpp at all
    /// if the path does not exist on disk.
    pub fn load(model_path: &Path) -> Result<Self, LlmError> {
        if !model_path.exists() {
            return Err(LlmError::ModelNotFound(model_path.to_path_buf()));
        }

        let backend = LlamaBackend::init().map_err(|err| LlmError::Load(err.to_string()))?;
        let model = LlamaModel::load_from_file(&backend, model_path, &LlamaModelParams::default())
            .map_err(|err| LlmError::Load(err.to_string()))?;

        Ok(Self { backend, model })
    }

    /// Format `prompt` via the model's chat template, run prefill, then
    /// stream generated tokens through `on_token` until end-of-generation,
    /// `opts.max_tokens`, or `cancel` is observed.
    ///
    /// Returns the accumulated generated text.
    pub fn summarize(
        &self,
        prompt: &str,
        opts: &SummaryOptions,
        cancel: &AtomicBool,
        mut on_token: impl FnMut(&str),
    ) -> Result<String, LlmError> {
        let formatted = self.format_prompt(prompt)?;
        let tokens = self
            .model
            .str_to_token(&formatted, AddBos::Always)
            .map_err(|err| LlmError::Tokenize(err.to_string()))?;

        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(opts.n_ctx))
            .with_n_threads(opts.n_threads);
        let mut ctx = self
            .model
            .new_context(&self.backend, ctx_params)
            .map_err(|err| LlmError::Context(err.to_string()))?;

        let mut batch = LlamaBatch::new(opts.n_ctx as usize, 1);
        let mut n_cur = prefill(&mut ctx, &mut batch, &tokens)?;

        let sampler = LlamaSampler::chain_simple([
            LlamaSampler::temp(opts.temperature),
            LlamaSampler::top_p(opts.top_p, TOP_P_MIN_KEEP),
            LlamaSampler::dist(opts.seed),
        ]);

        generate(
            &self.model,
            &mut ctx,
            &mut batch,
            sampler,
            &mut n_cur,
            opts.max_tokens,
            cancel,
            &mut on_token,
        )
    }

    /// Format `prompt` as a single user turn via the model's baked-in chat
    /// template, falling back to ChatML when the GGUF has none.
    fn format_prompt(&self, prompt: &str) -> Result<String, LlmError> {
        let template = match self.model.chat_template(None) {
            Ok(tmpl) => tmpl,
            Err(_) => LlamaChatTemplate::new(FALLBACK_CHAT_TEMPLATE)
                .map_err(|_| LlmError::NoChatTemplate)?,
        };

        let messages = vec![
            LlamaChatMessage::new("user".to_string(), prompt.to_string())
                .map_err(|err| LlmError::Tokenize(err.to_string()))?,
        ];

        self.model
            .apply_chat_template(&template, &messages, true)
            .map_err(|err| LlmError::Tokenize(err.to_string()))
    }
}

/// Feed `tokens` into `batch` and decode the prefill in one shot. Returns the
/// position (`n_cur`) immediately after the prefilled tokens.
fn prefill(
    ctx: &mut LlamaContext,
    batch: &mut LlamaBatch,
    tokens: &[LlamaToken],
) -> Result<i32, LlmError> {
    let last_index = tokens.len().saturating_sub(1);

    for (i, token) in tokens.iter().enumerate() {
        let is_last = i == last_index;
        batch
            .add(*token, i as i32, &[SEQUENCE_ID], is_last)
            .map_err(|err| LlmError::Context(err.to_string()))?;
    }

    ctx.decode(batch)
        .map_err(|err| LlmError::Context(err.to_string()))?;

    Ok(tokens.len() as i32)
}

/// Sample-decode loop: generate up to `max_tokens`, streaming each decoded
/// piece through `on_token`, stopping early on end-of-generation or
/// cancellation.
#[allow(clippy::too_many_arguments)]
fn generate(
    model: &LlamaModel,
    ctx: &mut LlamaContext,
    batch: &mut LlamaBatch,
    mut sampler: LlamaSampler,
    n_cur: &mut i32,
    max_tokens: u32,
    cancel: &AtomicBool,
    on_token: &mut impl FnMut(&str),
) -> Result<String, LlmError> {
    let mut generated = String::new();
    let mut decoder = encoding_rs::UTF_8.new_decoder();

    for _ in 0..max_tokens {
        let token = sampler.sample(ctx, batch.n_tokens() - 1);
        sampler.accept(token);

        if model.is_eog_token(token) {
            break;
        }

        let piece = decode_token(model, token, &mut decoder)?;
        on_token(&piece);
        generated.push_str(&piece);

        if cancel.load(Ordering::SeqCst) {
            return Err(LlmError::Cancelled);
        }

        batch.clear();
        batch
            .add(token, *n_cur, &[SEQUENCE_ID], true)
            .map_err(|err| LlmError::Context(err.to_string()))?;
        ctx.decode(batch)
            .map_err(|err| LlmError::Context(err.to_string()))?;
        *n_cur += 1;
    }

    Ok(generated)
}

/// Decode a single generated token to a UTF-8 string piece.
fn decode_token(
    model: &LlamaModel,
    token: LlamaToken,
    decoder: &mut Decoder,
) -> Result<String, LlmError> {
    model
        .token_to_piece(token, decoder, true, None)
        .map_err(|err| LlmError::Decode(err.to_string()))
}
