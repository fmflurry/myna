# Speaker diarization accuracy: from 45 spurious speakers to 2

How the "Detect speakers" pass went from reporting dozens of remote speakers
on a two-speaker call to reporting two, what was actually wrong, and how to
re-measure it. Written for a maintainer who has not touched diarization.

For the design of the diarization feature itself (manual trigger, confidence
rule, speaker names, pinning) see
[ADR 0009](adr/0009-speaker-diarization.md). This document only covers the
accuracy fix. The decision to ship it on by default is recorded in
[ADR 0016](adr/0016-diarization-centroid-merge.md).

## Summary

A 29-minute two-speaker meeting used as the reference recording produced
roughly 25-33 distinct `others:N` labels, with indices as high as
`others:171`. Three defects were involved. Two were about numbering honesty
and did not change accuracy. The third was the real bug: sherpa-onnx's
`FastClustering` has no minimum-cluster-size step, so embeddings from very
short windows form singleton clusters that nothing downstream can absorb,
and no clustering threshold can fix that. A post-clustering centroid merge
pass (`crates/myna-stt/src/cluster_merge.rs`) now takes the reference
recording from **45 clusters to 2** end to end through the production path.

Shipped defaults: `enable_centroid_merge = true`, `merge_threshold = 0.65`,
`min_cluster_sec = 5.0`, `min_embed_sec = 1.5`. The clustering `threshold`
stays at 0.5 and `num_clusters` stays at -1.

## The symptom

The reference recording has two remote speakers plus the local user ("Me").
After "Detect speakers", the transcript showed roughly 25-33 distinct
`others:N` labels and the highest index was `others:171`. Both numbers are
wrong in different ways: the count is far above 2, and the index namespace
is far larger than the count. Fewer labels than clusters is expected on its
own — the confidence rule in ADR 0009 leaves low-confidence segments bare
`others` — but neither figure was anywhere near the truth.

## How the pipeline works

Brief, so the defects below have context. The full design is in ADR 0009.

- Only `track-system.wav` is diarized. The mic track is "Me" by construction
  and is never clustered.
- Segmentation: pyannote-segmentation-3.0 (int8). Embedding: NeMo
  TitaNet-small. Runtime: sherpa-onnx 1.13.6.
- Clustering: `FastClusteringConfig { num_clusters: -1, threshold: 0.5 }` —
  an unbounded speaker count, agglomerative, cut by a cosine-distance
  threshold.
- Post-processing, all time-local: `exclude_short_segments` → `post_merge`
  → `smooth_labels`. None of these can merge two clusters that are the same
  person speaking at different points in the meeting.
- `crates/myna-stt/src/relabel.rs` maps cluster index `i` to the label
  `others:<i+1>`.

## The three defects

Defects 1 and 2 are numbering honesty: the labels were not lying about how
many people spoke so much as lying about *which* number belonged to whom.
Only defect 3 changed the speaker count.

### Defect 1 — sparse index namespace (cosmetic, fixed)

**What was wrong.** sherpa's `NumSpeakers()` returns the *distinct count* of
surviving clusters, but each segment's `speaker_index` is the *raw cluster
column id* in `0..=max_cluster_index`. sherpa drops segments shorter than
`min_duration_on` (0.3 s), so whole clusters can vanish and the surviving
ids become sparse. Myna assumed the two namespaces were the same.

**Evidence.** On the reference recording 45 clusters actually survived, but
ids reached 170 — hence the label `others:171`.

**Fix.** A new pure function, `compact_speaker_indices()`
(`crates/myna-stt/src/cluster_merge.rs`, used from `diarize.rs`), remaps
surviving indices to a dense `0..K` in order of first appearance by
`start_sec`, so `others:1` is the first voice heard, and sets
`num_speakers = K`. `DiarizeResult` now documents the invariant: every
`speaker_index < num_speakers`. The compaction runs in `diarize_wav` and
again after smoothing in `apply_diarize_result`, because smoothing can
out-vote an entire cluster.

A related bug was fixed at the same time: `num_speakers =
result.num_speakers.max(merged.num_speakers)` kept a stale, higher count
after post-processing had removed clusters.

### Defect 2 — cross-run index namespace mixing (fixed)

**What was wrong.** Cluster indices are only stable *within a single
diarization call*, but `relabel.rs` skipped any segment already tagged
`others:N`. A second "Detect speakers" run therefore mixed two index
namespaces: `others:1` from run A and `others:1` from run B could be
different people.

**Fix.** Unpinned, pure-numeric `others:N` labels are now relabel candidates
and are re-derived from the current run. Left untouched, as before:
segments with `speaker_pinned == true`, `me`, `unknown`, and user-minted
`others:m*` labels.

### Defect 3 — singleton clusters that nothing can absorb (fixed)

This is the accuracy bug. Threshold tuning provably cannot solve it; see the
next section. The fix is the centroid merge pass described after that.

## Why threshold tuning alone cannot work

Measured sweep of the clustering threshold on the full reference recording,
about 77 s per pass. Ground truth is 2 speakers. The `2 (pinned)` row sets
`num_clusters` to the ground truth instead of inferring it.

| clustering threshold   | num_clusters | min_duration_on | speakers |
| ---------------------- | ------------ | --------------- | -------- |
| 0.50 (was the default) | -1           | 0.30            | 45       |
| 0.60                   | -1           | 0.30            | 35       |
| 0.70                   | -1           | 0.30            | 26       |
| 0.80                   | -1           | 0.30            | 21       |
| 0.90                   | -1           | 0.30            | 14       |
| —                      | 2 (pinned)   | 0.30            | 2        |
| 0.80                   | -1           | 0.60            | 14       |

The count is monotone in the threshold but never reaches 2. Pinning
`num_clusters = 2` gives the right answer trivially, but only because the
answer was supplied.

Root cause: sherpa's `FastClustering` has no minimum-cluster-size or
nearest-centroid reassignment step. pyannote's own pipeline has one
(`min_cluster_size`). Embeddings extracted from very short windows form
singleton clusters, and no threshold on pairwise distance will fold a
distant singleton into a real speaker.

## The centroid merge pass

`crates/myna-stt/src/cluster_merge.rs` adds two pure steps after clustering:

1. `merge_centroids` — compute one duration-weighted, L2-normalised centroid
   per cluster, then iteratively merge the closest pair while their cosine
   similarity is at least `merge_threshold`.
2. `reassign_short_clusters` — dissolve any cluster with less than
   `min_cluster_sec` of total speech and reassign its segments to the
   nearest surviving centroid.

`compact_speaker_indices` then re-runs so the dense-index invariant from
defect 1 still holds.

Measured result grid on the reference recording (ground truth 2):

| merge τ | min_cluster_sec = 0 | min_cluster_sec = 5 | min_cluster_sec = 15 |
| ------- | ------------------- | ------------------- | -------------------- |
| 0.55    | 21                  | 2                   | 2                    |
| 0.65    | 23                  | 2                   | 2                    |
| 0.75    | 29                  | 2                   | 2                    |
| 0.85    | 37                  | 7                   | 3                    |

The same behaviour holds at clustering threshold 0.80 (21 → 2). End to end
through the production path the reference recording goes **45 → 2**. No
configuration in the grid collapsed to 1.

**The key insight.** Merging centroids alone only gets 45 → 21-23 (the
`min_cluster_sec = 0` column). The decisive step is the short-cluster
reassignment — exactly the `min_cluster_size` behaviour sherpa lacks. A
second observation: the two survivors never fused even at τ = 0.55, which is
evidence that they are genuinely distinct voices rather than shards of one.

## Shipped defaults and cost

Defaults in `DiarizeConfig`:

| setting                 | value |
| ----------------------- | ----- |
| `enable_centroid_merge` | true  |
| `merge_threshold`       | 0.65  |
| `min_cluster_sec`       | 5.0   |
| `min_embed_sec`         | 1.5   |
| clustering `threshold`  | 0.5   |
| `num_clusters`          | -1    |

`merge_threshold = 0.65` sits mid-plateau in the grid above, with margin on
both sides.

Cost, measured on the reference recording:

- Time: +3.4 s on a 72 s diarization (+4.7 %, RTF 0.041 → 0.043).
- Memory: peak RSS +138 MB. The merge pass loads a *second* TitaNet
  instance, because the one inside sherpa's `OfflineSpeakerDiarization` is
  not reachable through the C API.

## Known limitations and outstanding debt

State these plainly.

- The pass was tuned against **one** reference recording with 2 speakers and
  no hand-labelled ground truth. A meeting with 3 or more speakers has not
  been validated.
- `min_cluster_sec = 5.0` will absorb a participant who speaks less than
  5 seconds in total across the whole meeting.
- `reassign_short_clusters` sends clusters that could not be embedded to the
  *longest* surviving cluster. That is a heuristic, not a similarity
  decision, and it was not exercised on real data: every cluster was
  embeddable (45/45 before merging, 21/21 after).
- A user-supplied speaker count would pin the answer exactly
  (`num_clusters = 2` → 2). It was deliberately **not** made mandatory. It
  may return later as an optional override only.
- Test debt: the `#[ignore]`d sweep tests
  (`crates/myna-stt/tests/diarize_eval.rs` and
  `tests/integration/tests/diarize_ab.rs`) build their config with
  `..DiarizeConfig::default()`. With the merge pass now on by default, their
  "raw baseline" is no longer raw. They need an explicit
  `enable_centroid_merge: false` to keep measuring the unmerged baseline.

## How to re-measure

Point the sweep at a `track-system.wav` and run the ignored test in release
mode:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
MYNA_DIARIZE_SAMPLE_WAV=/path/to/track-system.wav \
  cargo test -p myna-stt --release --locked -- --ignored --nocapture diarize_merge_sweep
```

Output lines are greppable by prefix:

- `MYNA_SWEEP ...` — clustering-threshold sweep (the first table above).
- `MYNA_MERGE ...` — merge τ × `min_cluster_sec` grid (the second table).
- `MYNA_MERGE_E2E ...` — the production path, end to end.

**Gotcha.** The repo's `rtk` wrapper around `cargo` swallows test stdout even
with `--nocapture`. Either bypass it with `rtk proxy cargo test ...` or run
the built test binary under `target/release/deps/` directly.
