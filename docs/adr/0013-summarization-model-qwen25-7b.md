# ADR 0013: Upgrade the Summarization Model from Qwen2.5-3B to Qwen2.5-7B (Q4_K_M)

**Status**: Accepted  
**Date**: 2026-09-03  
**Builds on**: [ADR 0004: Safe llama.cpp Bindings](0004-safe-llama-bindings.md) (the engine that loads the GGUF) and [ADR 0009: Offline Speaker Diarization](0009-speaker-diarization.md) (the `models_status` presence gate this changes)  
**Amends**: [Stack Proposal](../stack-proposal.md) §7 (Summarization) — replaces its `Qwen2.5-3B-Instruct` Q4_K_M choice with `Qwen2.5-7B-Instruct` Q4_K_M as the single summarization model. The llama.cpp runtime (§2), the HF download path (§5), and the templated-prompt design (§8) all stand unchanged.

**Context**: Users reported that summaries generated with `Qwen2.5-3B-Instruct` (Q4_K_M) were "too light" — thin key points and action items that under-described real meetings. The 3B model was selected in the stack proposal (§7) for size conservatism: it keeps the download small and fits a CPU/Metal-friendly constraint, but that constraint was never a *measured* hardware floor — no benchmark pinned 3B as the largest model the target machines could run. Crucially, summarization is **on-demand only**: it runs when the user explicitly asks for a summary and a transcript is already available. It is not on the realtime path and is not latency-critical the way live STT is (ADR 0006/0008 capture, ADR 0011 session resilience). That asymmetry — a quality complaint on a non-latency-critical, user-triggered operation — is what makes a larger model the right lever.

## Decision

Replace `Qwen2.5-3B-Instruct` with **`Qwen2.5-7B-Instruct` GGUF, Q4_K_M quantization**, as the **single** summarization model.

- **One model, no tiering.** There is no 3B fallback and no high/low tier pair.
- **No model picker.** A user-facing model selector is explicitly out of scope for this change; a picker returns later *if and only if* multiple tiers are ever wanted. With a single model there is nothing to pick.
- **Engine configuration is unchanged.** Same `n_ctx = 32768`, same `n_gpu_layers = -1` (full Metal offload), same baked ChatML-family chat template. The swap is a model-artifact change, not an engine change.

## Rationale

### Why 7B when 3B was chosen for size?

The 3B choice optimized for download size against a constraint that was assumed, not measured. The complaint it produced — summaries "too light" — is a quality failure on the operation users actually judge Myna by, and it sits on a path where latency is not the binding constraint. A 7B Q4_K_M model roughly doubles parameter count while staying within a quantization scheme the runtime already handles well, directly targeting the reported weakness. Because summarization is on-demand and its output is streamed as it is produced, the extra generation time is masked by streaming and bounded by an explicit user action, so trading size and some latency for quality is favorable here in a way it would not be on the live STT path.

### Why a single model rather than a 3B/7B tier pair?

A tier pair would preserve a low-RAM option, but it reintroduces exactly the quality question this change exists to settle: which model is the default, and does anyone silently get the "too light" one? The user's stated preference is a single model — one quality bar for everyone. Tiering is deferred, not rejected on the merits; it is simply not what was asked for, and it has no payoff until there is a second model worth offering.

### Why no model picker?

A picker is UI and configuration surface for choosing among models. With one model there is nothing to choose, so a picker would be scaffolding for a capability that does not exist yet. It is deferred to the point where multiple tiers are genuinely wanted — the same condition that would justify tiering.

### Why the sharded GGUF, and why are both shards required?

The official `Qwen/Qwen2.5-7B-Instruct-GGUF` repository ships the Q4_K_M quantization as **two shards** — `qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf` and `qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf` — totalling ≈4.7 GB. llama.cpp loads a split GGUF by being pointed at the **shard-1 path**; it discovers and reads the remaining shard(s) from there. Because a half-downloaded model is unusable, **both shards must be present** for the model to count as installed: presence detection (`models_status`) and `download --check` are keyed on both files, so a partial download is reported as missing rather than as a broken-but-present model.

### Why is template risk zero?

`Qwen2.5-7B-Instruct` is the same model family as the incumbent 3B, and llama.cpp bakes the ChatML-family chat template into the GGUF. The engine reads the baked template exactly as it did for 3B; the summarization templates (stack proposal §8) sit above the chat template and are untouched. No template selection, no `enable_thinking`-style kwarg, no prompt-shape change — which is precisely the risk that makes the Qwen3 alternative (below) not yet ready.

## Options Considered

### Keep 3B as a low-RAM fallback tier
- **Pros**: Preserves a smaller/lighter option for constrained machines; no one is forced onto the 4.7 GB model.
- **Cons**: Reopens the "too light" quality question for anyone who lands on that tier, and implies a picker or a default-selection rule the change is trying to avoid.
- **Rejected**: The user asked for a single model. Tiering is deferred, not disqualifying — it returns with a picker if a second tier is ever wanted.

### Model picker + RAM-based tiering
- **Pros**: Lets each user choose the model that fits their hardware; a natural home for both 3B and 7B.
- **Cons**: Builds UI and configuration surface for a choice that does not exist while there is only one model; the RAM-tiering logic is speculative without a measured hardware floor.
- **Rejected / deferred**: No second model to pick. Revisit only when multiple tiers are genuinely offered.

### Qwen3-8B (better quality)
- **Pros**: Higher summary quality than Qwen2.5-7B.
- **Cons**: The Qwen3 GGUF chat template **defaults thinking ON**, and the current engine **cannot pass an `enable_thinking` kwarg**, so raw output leaks `<think>` reasoning blocks into the summary. This is a real correctness bug on the output path, not a tuning nit.
- **Rejected / deferred**: Blocked on engine-side named-template selection. Follow-up below.

### q3_k_m single-file quantization (of 7B)
- **Pros**: A single ~3.3 GB file avoids the two-shard download and presence-detection complexity; smaller footprint.
- **Cons**: A lower quantization trades away the very quality this change exists to buy.
- **Rejected**: Quality is the whole point of the swap; degrading the quant to dodge a download detail defeats the decision.

## Consequences

### Positive
- Summaries address the reported "too light" weakness — a larger, same-family model on a non-latency-critical, user-triggered path.
- No engine changes: same `n_ctx`, same full-Metal offload, same baked ChatML-family template — so no new template-selection or prompt-shape risk.
- Presence detection stays honest: requiring both shards means a partial download reads as *missing*, not as a broken model that loads and then fails.
- The single-model rule keeps the quality bar uniform and the UI free of a picker that would have nothing to pick.

### Negative
- **Download grows to ≈4.7 GB** for the Qwen artifact (total downloaded artifacts ≈5.4 GB), up from ≈1.9 GB for 3B.
- **Peak RAM ≈5–6 GB**, making a **12–16 GB Mac the practical floor** for comfortable use.
- **First summary can take up to ~1 minute for a 30-minute meeting** (versus 20–30 s on 3B). Accepted because the operation is on-demand and the wait is masked by streaming output.
- **Existing installs see the qwen slot as "missing" on first launch** after the update, so the in-app download re-prompts. No code path breaks — the re-prompt is the intended, already-shipped download flow doing its job.
- **Stale `~/myna/models/qwen2.5-3b-instruct` is left in place deliberately.** Auto-deleting user data was rejected; cleanup is a documented manual step (see Implementation Notes).

## Implementation Notes

- **Artifact**: `Qwen/Qwen2.5-7B-Instruct-GGUF`, Q4_K_M, shipped as two shards — `qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf` and `qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf` (≈4.7 GB combined).
- **Load path**: point llama.cpp at the **shard-1** file; the runtime resolves the remaining shard(s) from it.
- **Presence / check**: `models_status` and `download --check` require **both shards** before reporting the qwen model present, so a partial download surfaces as missing and re-prompts the in-app download.
- **Engine params unchanged**: `n_ctx = 32768` (native 32K context on 7B), `n_gpu_layers = -1` (full Metal offload), baked ChatML-family template read as before.
- **First-launch behaviour for existing users**: the qwen slot reads missing after the update; the in-app download re-prompts and fetches the 7B shards. Nothing else changes.
- **Manual cleanup of the old model** (left in place on purpose — no auto-delete of user data):
  ```bash
  rm -rf ~/myna/models/qwen2.5-3b-instruct
  ```

## Open Risks & Follow-ups

- **Hardware floor is now real.** The 12–16 GB recommendation is a consequence of the larger model, not a measured pre-existing constraint. Machines below that may struggle; this is the cost the quality decision accepted.
- **Qwen3 enablement (deferred).** Moving to Qwen3 requires the engine to select the `nothinking` chat template by name and a guard that strips any residual `<think>` tags before the summary is shown — closing the `<think>`-leakage blocker that kept Qwen3-8B out of this change. Once that lands, a Qwen3 **14B high tier** becomes worth considering alongside a picker.

## References

- **Engine / bindings**: [ADR 0004: Safe llama.cpp Bindings](0004-safe-llama-bindings.md) — the runtime that loads the split GGUF.
- **Presence gate**: [ADR 0009: Offline Speaker Diarization](0009-speaker-diarization.md) — `models_status` / `all_present` gate whose qwen slot this re-points to the 7B shards.
- **Prior model choice**: [Stack Proposal](../stack-proposal.md) §7 (Summarization) — the 3B selection this amends; §2 (llama.cpp runtime) and §8 (templates) are unchanged.
- **On-demand / non-latency framing**: [ADR 0011: Disk-Backed Session State](0011-session-resilience.md) — summarization runs after a transcript exists, off the realtime capture path.
- **Model artifact**: `Qwen/Qwen2.5-7B-Instruct-GGUF` (Q4_K_M, sharded) on the Hugging Face Hub.

## Revision History

- **2026-09-03**: Accepted. Summarization model upgraded from `Qwen2.5-3B-Instruct` Q4_K_M to `Qwen2.5-7B-Instruct` Q4_K_M as the single model — no tiering, no 3B fallback, no picker (deferred). Shipped as two GGUF shards (≈4.7 GB) loaded from the shard-1 path; both shards required for `models_status` and `download --check`. Engine params unchanged (`n_ctx = 32768`, `n_gpu_layers = -1`, baked ChatML-family template → zero template risk). Consequences: total artifacts ≈5.4 GB, peak RAM ≈5–6 GB (12–16 GB Mac floor), first summary up to ~1 min for a 30-min meeting (on-demand, streaming-masked), existing installs re-prompt the in-app download, stale 3B dir left in place with manual `rm -rf ~/myna/models/qwen2.5-3b-instruct` cleanup. Rejected/deferred alternatives: 3B fallback tier, model picker + RAM tiering, Qwen3-8B (blocked on `enable_thinking`/`<think>` leakage — follow-up: `nothinking` named-template selection + think-tag strip guard, then consider a 14B high tier), and q3_k_m single-file quant (quality is the point).
