# ADR 0016: Enable the Diarization Centroid-Merge Pass by Default

**Status**: Decided  
**Date**: 2026-09-09  
**Builds on**: [ADR 0009](0009-speaker-diarization.md) — offline speaker
diarization  
**Context**: ADR 0009 flagged accuracy as UNVERIFIED and required a real
multi-party call to be recorded and inspected. That inspection happened. On a
29-minute two-speaker meeting the pipeline as decided in ADR 0009 produced 45
surviving clusters and labels as high as `others:171`. The diagnosis, the
measurements, and the fix are written up in full in
[docs/diarization-accuracy.md](../diarization-accuracy.md); this ADR only
records the decision.

## Decision

Run a post-clustering **centroid merge pass** (`crates/myna-stt/src/cluster_merge.rs`)
after sherpa-onnx's `FastClustering`, and enable it by default:

- `enable_centroid_merge = true`
- `merge_threshold = 0.65`
- `min_cluster_sec = 5.0`
- `min_embed_sec = 1.5`

The clustering settings from ADR 0009 are unchanged: `threshold = 0.5`,
`num_clusters = -1`.

The pass merges cluster centroids whose cosine similarity is at least
`merge_threshold`, then dissolves clusters with less than `min_cluster_sec` of
total speech and reassigns their segments to the nearest surviving centroid.
This supplies the minimum-cluster-size behaviour that pyannote's own pipeline
has and sherpa's `FastClustering` lacks. Measured on the reference recording,
the production path goes from 45 speakers to 2.

## Why not tune the clustering threshold instead

A measured sweep of the clustering threshold from 0.50 to 0.90 went
45 → 35 → 26 → 21 → 14 speakers — monotone, never 2. Embeddings from very
short windows form singleton clusters that no pairwise-distance threshold can
absorb. The table is in the long-form document.

## Why not require a user-supplied speaker count

Pinning `num_clusters = 2` returns 2 exactly, but only because the answer was
supplied. Making it mandatory was rejected; it may return later as an optional
override only.

## Consequences

### Positive

- Speaker count on the reference recording matches ground truth (45 → 2)
  without any user input.
- Labels are dense and stable within a run: every `speaker_index <
  num_speakers`, and `others:1` is the first voice heard.

### Negative

- +3.4 s on a 72 s diarization (+4.7 %, RTF 0.041 → 0.043) and +138 MB peak
  RSS, because the pass loads a second TitaNet instance (the one inside
  sherpa's `OfflineSpeakerDiarization` is not reachable through the C API).
- Tuned against one two-speaker recording with no hand-labelled ground truth.
  Meetings with 3 or more speakers are not validated.
- A participant who speaks less than 5 s in total across the meeting will be
  absorbed into another speaker.
- The `#[ignore]`d sweep tests still build with `..DiarizeConfig::default()`,
  so their "raw baseline" now includes the merge pass. They need an explicit
  `enable_centroid_merge: false` to keep measuring the unmerged baseline.

## References

- [docs/diarization-accuracy.md](../diarization-accuracy.md) — symptom,
  three defects, sweep and grid tables, cost, limitations, how to re-measure.
- [ADR 0009](0009-speaker-diarization.md) — the diarization feature this
  modifies.

## Revision History

- **2026-09-09**: Decision recorded. Centroid merge pass enabled by default
  with `merge_threshold = 0.65`, `min_cluster_sec = 5.0`,
  `min_embed_sec = 1.5`. Reference recording: 45 → 2 speakers.
