//! Post-clustering centroid merge + short-cluster reassignment ("B1").
//!
//! sherpa-onnx's `FastClustering` agglomerates per-chunk embeddings with a
//! single cosine `threshold` and has no `min_cluster_size`, so a long
//! meeting with two voices routinely comes back as dozens of clusters —
//! many of them a handful of seconds of one real speaker. This module
//! collapses those spurious clusters *after* clustering, purely from
//! per-cluster centroids and speech durations, so no speaker count is ever
//! required from the user:
//!
//! 1. [`merge_centroids`] — iteratively merge the closest pair of cluster
//!    centroids while their cosine similarity is `>= merge_threshold`,
//!    recomputing the merged centroid as the duration-weighted mean of its
//!    members (re-normalised).
//! 2. [`reassign_short_clusters`] — dissolve any cluster whose total speech
//!    is `< min_cluster_sec` and hand its segments to the nearest surviving
//!    centroid (the `min_cluster_size` behaviour pyannote has).
//!
//! Everything here is pure and deterministic: inputs are borrowed, outputs
//! are new values, and nothing touches a model. Embedding extraction (the
//! only model-dependent step) lives in [`crate::diarize`]; this module only
//! consumes the resulting `Option<Vec<f32>>` per cluster.

use crate::diarize::{DiarizeResult, DiarizeSegment};

/// Knobs for [`merge_and_reassign`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClusterMergeConfig {
    /// Cosine similarity at or above which two cluster centroids merge.
    pub merge_threshold: f32,
    /// Clusters with less total speech than this are dissolved into their
    /// nearest surviving neighbour.
    pub min_cluster_sec: f32,
}

/// Returns `v` scaled to unit L2 norm; a zero (or non-finite-norm) vector
/// is returned as an all-zero copy so it never matches anything.
pub fn l2_normalize(v: &[f32]) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if !norm.is_finite() || norm <= 0.0 {
        return vec![0.0; v.len()];
    }
    v.iter().map(|x| x / norm).collect()
}

/// Cosine similarity of two vectors. Mismatched lengths or a zero vector
/// yield `0.0` rather than panicking.
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if na <= 0.0 || nb <= 0.0 || !na.is_finite() || !nb.is_finite() {
        return 0.0;
    }
    dot / (na * nb)
}

/// One agglomerated group during [`merge_centroids`].
#[derive(Debug, Clone)]
struct Group {
    /// Input cluster ids in this group, ascending.
    members: Vec<usize>,
    /// Unit-norm duration-weighted mean of the members' centroids.
    centroid: Vec<f32>,
    /// Total speech duration of the members.
    duration: f32,
}

/// Duration-weighted mean of `a` and `b`, re-normalised. Weights are floored
/// at a tiny epsilon so a zero-duration cluster still contributes rather
/// than producing NaN.
fn weighted_mean(a: &[f32], wa: f32, b: &[f32], wb: f32) -> Vec<f32> {
    const EPS: f32 = 1e-6;
    let wa = if wa.is_finite() { wa.max(EPS) } else { EPS };
    let wb = if wb.is_finite() { wb.max(EPS) } else { EPS };
    let mixed: Vec<f32> = a
        .iter()
        .zip(b)
        .map(|(x, y)| (x * wa + y * wb) / (wa + wb))
        .collect();
    l2_normalize(&mixed)
}

/// Finds the most similar pair of groups, ties broken toward the lowest
/// `(i, j)`. `None` when fewer than two groups exist.
fn closest_pair(groups: &[Group]) -> Option<(usize, usize, f32)> {
    let mut best: Option<(usize, usize, f32)> = None;
    for i in 0..groups.len() {
        for j in (i + 1)..groups.len() {
            let sim = cosine_similarity(&groups[i].centroid, &groups[j].centroid);
            if best.is_none_or(|(_, _, s)| sim > s) {
                best = Some((i, j, sim));
            }
        }
    }
    best
}

/// Merges groups `i` and `j` (`i < j`) into a new group list.
fn merge_pair(groups: &[Group], i: usize, j: usize) -> Vec<Group> {
    let mut members: Vec<usize> = groups[i]
        .members
        .iter()
        .chain(groups[j].members.iter())
        .copied()
        .collect();
    members.sort_unstable();
    let merged = Group {
        centroid: weighted_mean(
            &groups[i].centroid,
            groups[i].duration,
            &groups[j].centroid,
            groups[j].duration,
        ),
        duration: groups[i].duration + groups[j].duration,
        members,
    };
    let mut next: Vec<Group> = groups
        .iter()
        .enumerate()
        .filter(|(k, _)| *k != i && *k != j)
        .map(|(_, g)| g.clone())
        .collect();
    next.push(merged);
    // Deterministic order: by smallest member id.
    next.sort_by_key(|g| g.members[0]);
    next
}

/// Turns a group list into an `old cluster -> new cluster` mapping where new
/// ids are dense `0..groups.len()` in order of each group's smallest member.
fn groups_to_mapping(groups: &[Group], n: usize) -> Vec<usize> {
    let mut sorted: Vec<&Group> = groups.iter().collect();
    sorted.sort_by_key(|g| g.members[0]);
    let mut mapping = vec![0usize; n];
    for (new_id, group) in sorted.iter().enumerate() {
        for &m in &group.members {
            mapping[m] = new_id;
        }
    }
    mapping
}

/// Iteratively merges the closest pair of centroids while their cosine
/// similarity is `>= cfg.merge_threshold`.
///
/// `centroids[k]` and `durations[k]` describe cluster `k`; each merged
/// centroid is the duration-weighted mean of its members, re-normalised.
/// Returns `mapping` with `mapping[k]` the new (dense, `0..K'`) id of old
/// cluster `k`, numbered by order of the smallest member id so the mapping
/// is stable and reproducible. Pure: inputs are untouched.
///
/// Edge cases: empty input returns an empty mapping; a single cluster maps
/// to `[0]`; a non-finite threshold disables merging (identity mapping);
/// a `durations` slice shorter than `centroids` treats missing entries as
/// zero-duration.
pub fn merge_centroids(
    centroids: &[Vec<f32>],
    durations: &[f32],
    cfg: &ClusterMergeConfig,
) -> Vec<usize> {
    let n = centroids.len();
    if n == 0 {
        return Vec::new();
    }
    let mut groups: Vec<Group> = centroids
        .iter()
        .enumerate()
        .map(|(k, c)| Group {
            members: vec![k],
            centroid: l2_normalize(c),
            duration: durations.get(k).copied().unwrap_or(0.0),
        })
        .collect();
    if !cfg.merge_threshold.is_finite() {
        return groups_to_mapping(&groups, n);
    }
    while let Some((i, j, sim)) = closest_pair(&groups) {
        if sim < cfg.merge_threshold {
            break;
        }
        groups = merge_pair(&groups, i, j);
    }
    groups_to_mapping(&groups, n)
}

/// Dissolves every cluster whose total speech is `< cfg.min_cluster_sec`
/// and assigns it to the nearest *surviving* cluster by cosine similarity.
///
/// A cluster survives when its duration is at or above the floor **and**
/// it has a centroid. A short cluster with a centroid goes to the most
/// similar survivor; a short cluster with no centroid (no embeddable audio
/// at all — by construction a pile of sub-second blips) goes to the
/// longest survivor, the statistically safest home. If nothing survives
/// (every cluster is short, or none has a centroid) the mapping is the
/// identity: this pass never collapses a recording to zero speakers or
/// invents a merge it cannot justify.
///
/// Returns `mapping[k]` = surviving cluster id for old cluster `k`. Ids are
/// *not* re-densified here — callers run
/// [`crate::compact_speaker_indices`] after applying the mapping. Pure.
pub fn reassign_short_clusters(
    centroids: &[Option<Vec<f32>>],
    durations: &[f32],
    cfg: &ClusterMergeConfig,
) -> Vec<usize> {
    let n = centroids.len();
    let identity: Vec<usize> = (0..n).collect();
    if n <= 1 || !cfg.min_cluster_sec.is_finite() || cfg.min_cluster_sec <= 0.0 {
        return identity;
    }
    let duration_of = |k: usize| durations.get(k).copied().unwrap_or(0.0);
    let survivors: Vec<usize> = (0..n)
        .filter(|&k| centroids[k].is_some() && duration_of(k) >= cfg.min_cluster_sec)
        .collect();
    if survivors.is_empty() {
        return identity;
    }
    let longest_survivor = survivors
        .iter()
        .copied()
        .max_by(|&a, &b| {
            duration_of(a)
                .partial_cmp(&duration_of(b))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(survivors[0]);

    (0..n)
        .map(|k| {
            if survivors.contains(&k) {
                return k;
            }
            match &centroids[k] {
                None => longest_survivor,
                Some(c) => survivors
                    .iter()
                    .copied()
                    .map(|s| {
                        let target = centroids[s].as_deref().unwrap_or(&[]);
                        (s, cosine_similarity(c, target))
                    })
                    .fold(None::<(usize, f32)>, |best, (s, sim)| match best {
                        Some((_, b)) if sim <= b => best,
                        _ => Some((s, sim)),
                    })
                    .map(|(s, _)| s)
                    .unwrap_or(longest_survivor),
            }
        })
        .collect()
}

/// Full B1 pass: [`merge_centroids`] over the clusters that have a centroid,
/// then [`reassign_short_clusters`] over the merged groups. Returns the
/// composed `old cluster -> final cluster` mapping (not re-densified).
///
/// Clusters without a centroid skip the merge step (they keep a singleton
/// group) and are absorbed by the reassignment step when they are short.
pub fn merge_and_reassign(
    centroids: &[Option<Vec<f32>>],
    durations: &[f32],
    cfg: &ClusterMergeConfig,
) -> Vec<usize> {
    let n = centroids.len();
    if n == 0 {
        return Vec::new();
    }
    let duration_of = |k: usize| durations.get(k).copied().unwrap_or(0.0);

    // Step 1: merge among clusters that have a centroid.
    let embedded: Vec<usize> = (0..n).filter(|&k| centroids[k].is_some()).collect();
    let embedded_centroids: Vec<Vec<f32>> = embedded
        .iter()
        .map(|&k| centroids[k].clone().unwrap_or_default())
        .collect();
    let embedded_durations: Vec<f32> = embedded.iter().map(|&k| duration_of(k)).collect();
    let merged_local = merge_centroids(&embedded_centroids, &embedded_durations, cfg);
    let merged_group_count = merged_local.iter().copied().max().map_or(0, |m| m + 1);

    // Group ids: merged groups first (0..merged_group_count), then one
    // singleton group per centroid-less cluster.
    let mut group_of = vec![0usize; n];
    let mut next_group = merged_group_count;
    for (k, slot) in group_of.iter_mut().enumerate() {
        match embedded.iter().position(|&e| e == k) {
            Some(local) => *slot = merged_local[local],
            None => {
                *slot = next_group;
                next_group += 1;
            }
        }
    }
    let group_count = next_group;

    // Step 2: per-group duration-weighted centroid + total duration.
    let mut sums: Vec<Option<Vec<f32>>> = vec![None; group_count];
    let mut group_durations = vec![0.0f32; group_count];
    for k in 0..n {
        let g = group_of[k];
        let d = duration_of(k);
        group_durations[g] += d;
        if let Some(c) = &centroids[k] {
            let unit = l2_normalize(c);
            let w = if d.is_finite() { d.max(1e-6) } else { 1e-6 };
            sums[g] = Some(match &sums[g] {
                None => unit.iter().map(|x| x * w).collect(),
                Some(acc) => acc.iter().zip(&unit).map(|(a, x)| a + x * w).collect(),
            });
        }
    }
    let group_centroids: Vec<Option<Vec<f32>>> = sums
        .iter()
        .map(|s| s.as_ref().map(|v| l2_normalize(v)))
        .collect();

    // Step 3: absorb short groups, then compose.
    let reassigned = reassign_short_clusters(&group_centroids, &group_durations, cfg);
    group_of.iter().map(|&g| reassigned[g]).collect()
}

/// Total speech duration per cluster, indexed by `speaker_index`, with
/// length `max(num_speakers, max index + 1)` so it is safe to index by any
/// segment's speaker. Pure.
pub fn cluster_durations(result: &DiarizeResult) -> Vec<f32> {
    let max_index = result
        .segments
        .iter()
        .map(|s| s.speaker_index as usize + 1)
        .max()
        .unwrap_or(0);
    let len = (result.num_speakers as usize).max(max_index);
    let mut durations = vec![0.0f32; len];
    for seg in &result.segments {
        durations[seg.speaker_index as usize] += (seg.end_sec - seg.start_sec).max(0.0);
    }
    durations
}

/// Applies an `old cluster -> new cluster` mapping to every segment,
/// returning a new [`DiarizeResult`] whose `num_speakers` is the distinct
/// count of mapped ids. Segments whose index is outside `mapping` keep their
/// index. Order is preserved. Pure.
pub fn apply_cluster_mapping(result: &DiarizeResult, mapping: &[usize]) -> DiarizeResult {
    let segments: Vec<DiarizeSegment> = result
        .segments
        .iter()
        .map(|seg| DiarizeSegment {
            start_sec: seg.start_sec,
            end_sec: seg.end_sec,
            speaker_index: mapping
                .get(seg.speaker_index as usize)
                .map_or(seg.speaker_index, |&m| m as u32),
        })
        .collect();
    let mut ids: Vec<u32> = segments.iter().map(|s| s.speaker_index).collect();
    ids.sort_unstable();
    ids.dedup();
    DiarizeResult {
        num_speakers: ids.len() as u32,
        segments,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(merge_threshold: f32, min_cluster_sec: f32) -> ClusterMergeConfig {
        ClusterMergeConfig {
            merge_threshold,
            min_cluster_sec,
        }
    }

    fn seg(start_sec: f32, end_sec: f32, speaker_index: u32) -> DiarizeSegment {
        DiarizeSegment {
            start_sec,
            end_sec,
            speaker_index,
        }
    }

    #[test]
    fn merge_centroids_collapses_two_tight_groups_to_two() {
        // Group A hugs the x axis, group B hugs the y axis; within-group
        // cosine ~0.98, across-group ~0.2.
        let centroids = vec![
            vec![1.0, 0.1, 0.0],
            vec![1.0, 0.0, 0.1],
            vec![0.95, 0.15, 0.05],
            vec![0.1, 1.0, 0.0],
            vec![0.0, 1.0, 0.1],
        ];
        let durations = vec![30.0, 10.0, 5.0, 40.0, 8.0];

        let mapping = merge_centroids(&centroids, &durations, &cfg(0.8, 0.0));

        assert_eq!(mapping, vec![0, 0, 0, 1, 1]);
    }

    #[test]
    fn merge_centroids_never_merges_orthogonal_vectors() {
        let centroids = vec![
            vec![1.0, 0.0, 0.0],
            vec![0.0, 1.0, 0.0],
            vec![0.0, 0.0, 1.0],
        ];
        let durations = vec![10.0, 10.0, 10.0];

        let mapping = merge_centroids(&centroids, &durations, &cfg(0.5, 0.0));

        assert_eq!(mapping, vec![0, 1, 2]);
    }

    #[test]
    fn merge_centroids_uses_duration_weighted_mean_for_merged_centroids() {
        // Clusters 0 and 1 merge first (cos ~0.995). If the merged centroid
        // were the plain mean it would sit at 45 deg between them; with
        // cluster 0 weighted 100:1 it stays on cluster 0's side, so the
        // outlier 2 (close to cluster 1 only) must NOT reach the 0.9 bar.
        let c0 = l2_normalize(&[1.0, 0.0]);
        let c1 = l2_normalize(&[0.995, 0.1]);
        let c2 = l2_normalize(&[0.90, 0.436]); // cos(c1,c2) ~ 0.93, cos(c0,c2) ~ 0.90-
        let centroids = vec![c0, c1, c2];
        let mapping = merge_centroids(&centroids, &[100.0, 1.0, 1.0], &cfg(0.91, 0.0));

        assert_eq!(mapping[0], mapping[1], "tight pair merges");
        assert_ne!(
            mapping[2], mapping[0],
            "the heavy member anchors the merged centroid away from the outlier"
        );
    }

    #[test]
    fn merge_centroids_is_a_no_op_on_empty_and_single_inputs() {
        assert!(merge_centroids(&[], &[], &cfg(0.5, 0.0)).is_empty());
        assert_eq!(
            merge_centroids(&[vec![0.3, 0.4]], &[1.0], &cfg(0.5, 0.0)),
            vec![0]
        );
    }

    #[test]
    fn merge_centroids_ignores_zero_vectors_and_non_finite_thresholds() {
        let centroids = vec![vec![0.0, 0.0], vec![1.0, 0.0], vec![1.0, 0.0]];
        // Zero vector never matches; identical vectors do.
        assert_eq!(
            merge_centroids(&centroids, &[1.0, 1.0, 1.0], &cfg(0.5, 0.0)),
            vec![0, 1, 1]
        );
        // NaN threshold disables merging.
        assert_eq!(
            merge_centroids(&centroids, &[1.0, 1.0, 1.0], &cfg(f32::NAN, 0.0)),
            vec![0, 1, 2]
        );
    }

    #[test]
    fn reassign_short_clusters_absorbs_a_sub_threshold_cluster_into_its_nearest_neighbour() {
        // Cluster 2 has 2 s of speech (below the 5 s floor) and points
        // toward cluster 1, so it must join 1 — not the longer cluster 0.
        let centroids = vec![
            Some(vec![1.0, 0.0]),
            Some(vec![0.0, 1.0]),
            Some(vec![0.2, 0.9]),
        ];
        let durations = vec![100.0, 20.0, 2.0];

        let mapping = reassign_short_clusters(&centroids, &durations, &cfg(0.5, 5.0));

        assert_eq!(mapping, vec![0, 1, 1]);
    }

    #[test]
    fn reassign_short_clusters_sends_centroidless_clusters_to_the_longest_survivor() {
        let centroids = vec![Some(vec![1.0, 0.0]), Some(vec![0.0, 1.0]), None];
        let durations = vec![20.0, 100.0, 1.0];

        let mapping = reassign_short_clusters(&centroids, &durations, &cfg(0.5, 5.0));

        assert_eq!(mapping, vec![0, 1, 1]);
    }

    #[test]
    fn reassign_short_clusters_is_identity_when_nothing_survives_or_input_is_trivial() {
        // All short: never collapse.
        let centroids = vec![Some(vec![1.0, 0.0]), Some(vec![0.0, 1.0])];
        assert_eq!(
            reassign_short_clusters(&centroids, &[1.0, 1.0], &cfg(0.5, 5.0)),
            vec![0, 1]
        );
        // Disabled floor.
        assert_eq!(
            reassign_short_clusters(&centroids, &[1.0, 100.0], &cfg(0.5, 0.0)),
            vec![0, 1]
        );
        // Empty / single.
        assert!(reassign_short_clusters(&[], &[], &cfg(0.5, 5.0)).is_empty());
        assert_eq!(
            reassign_short_clusters(&[Some(vec![1.0])], &[0.1], &cfg(0.5, 5.0)),
            vec![0]
        );
    }

    #[test]
    fn merge_and_reassign_composes_merge_then_absorption() {
        // 0 and 1 are the same voice (merge); 2 is a distinct voice with
        // plenty of speech (survives); 3 is a 1 s blip near voice 2
        // (absorbed by 2); 4 has no centroid (goes to the longest group,
        // which is 0+1 at 40 s).
        let centroids = vec![
            Some(vec![1.0, 0.0, 0.0]),
            Some(vec![0.98, 0.05, 0.0]),
            Some(vec![0.0, 1.0, 0.0]),
            Some(vec![0.05, 0.95, 0.0]),
            None,
        ];
        let durations = vec![30.0, 10.0, 20.0, 1.0, 0.5];

        let mapping = merge_and_reassign(&centroids, &durations, &cfg(0.9, 5.0));

        assert_eq!(mapping[0], mapping[1]);
        assert_ne!(mapping[0], mapping[2]);
        assert_eq!(mapping[3], mapping[2]);
        assert_eq!(mapping[4], mapping[0]);
    }

    #[test]
    fn merge_and_reassign_is_a_no_op_on_empty_and_single_inputs() {
        assert!(merge_and_reassign(&[], &[], &cfg(0.65, 5.0)).is_empty());
        assert_eq!(
            merge_and_reassign(&[Some(vec![1.0, 0.0])], &[0.5], &cfg(0.65, 5.0)),
            vec![0]
        );
        assert_eq!(
            merge_and_reassign(&[None], &[0.5], &cfg(0.65, 5.0)),
            vec![0]
        );
    }

    #[test]
    fn cluster_durations_sums_per_speaker_and_covers_num_speakers() {
        let result = DiarizeResult {
            num_speakers: 3,
            segments: vec![seg(0.0, 2.0, 0), seg(2.0, 3.5, 1), seg(4.0, 5.0, 0)],
        };

        assert_eq!(cluster_durations(&result), vec![3.0, 1.5, 0.0]);
        assert!(cluster_durations(&DiarizeResult::default()).is_empty());
    }

    #[test]
    fn apply_cluster_mapping_relabels_and_recounts_without_mutating_input() {
        let result = DiarizeResult {
            num_speakers: 3,
            segments: vec![seg(0.0, 1.0, 0), seg(1.0, 2.0, 1), seg(2.0, 3.0, 2)],
        };
        let snapshot = result.clone();

        let mapped = apply_cluster_mapping(&result, &[0, 0, 2]);

        assert_eq!(
            mapped.segments,
            vec![seg(0.0, 1.0, 0), seg(1.0, 2.0, 0), seg(2.0, 3.0, 2)]
        );
        assert_eq!(mapped.num_speakers, 2);
        assert_eq!(result, snapshot);
    }
}
