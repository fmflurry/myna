//! Manual meeting-ordering decision logic: pure functions, no I/O.
//!
//! Meetings are ordered by an *effective position* -- an `f64` rank in a
//! sparse fractional-indexing scheme, so a drop between two neighbours
//! costs exactly one write (the target's own row) rather than a dense
//! reindex of everything between it and the top of the list.
//!
//! **Rank space is seconds, negated.** A meeting that has never been
//! manually placed (`position: None`) falls back to
//! `-created_at.unix_timestamp()`. Sorted ascending, the most recently
//! created meeting has the largest `unix_timestamp` and therefore the
//! smallest (most negative) effective position, so it sorts first --
//! newest-first, exactly matching the plain `created_at` DESC order this
//! feature replaces. Manually placed meetings simply use their explicit
//! `position` instead, letting placed and unplaced meetings interleave in
//! one consistent ascending sort.

use crate::domain::meeting::Meeting;

/// Minimum gap left between a new position and its one known neighbour when
/// dropping at the very top or bottom of a list (no neighbour on the other
/// side to bound the midpoint).
pub const RANK_GAP: f64 = 1.0;

/// The outcome of resolving a drop between two (already effective-position
/// resolved) neighbours.
#[derive(Debug, PartialEq)]
pub enum Placement {
    /// Neither neighbour carries an explicit position -- leave the target's
    /// position exactly as it is.
    Keep,
    /// Give the target this explicit position.
    Set(f64),
    /// No `f64` value can be safely computed between the two neighbours
    /// (they are equal, inverted, or too close together for `f64`
    /// precision to represent a strict midpoint). The caller must
    /// renormalize the affected container to fresh, evenly spaced
    /// positions and retry.
    Renormalize,
}

/// The rank a meeting sorts by: its explicit `position` when set, or a
/// fallback derived from `created_at` -- see the module docs for the rank
/// space this fallback lives in.
pub fn effective_position(meeting: &Meeting) -> f64 {
    meeting
        .position
        .unwrap_or(-(meeting.created_at.unix_timestamp() as f64))
}

/// Resolves a drop between `prev` (the neighbour effective position above
/// the target, or `None` when dropping at the very top) and `next` (the
/// neighbour below, or `None` when dropping at the very bottom) into a
/// placement decision.
pub fn resolve_placement(prev: Option<f64>, next: Option<f64>) -> Placement {
    match (prev, next) {
        (None, None) => Placement::Keep,
        (None, Some(next)) => Placement::Set(next - RANK_GAP),
        (Some(prev), None) => Placement::Set(prev + RANK_GAP),
        (Some(prev), Some(next)) => {
            if prev >= next {
                return Placement::Renormalize;
            }
            let midpoint = prev + (next - prev) / 2.0;
            if midpoint <= prev || midpoint >= next {
                Placement::Renormalize
            } else {
                Placement::Set(midpoint)
            }
        }
    }
}
