//! Integration tests for manual meeting ordering: the pure
//! `domain::placement` decision logic (`effective_position`,
//! `resolve_placement`) and the `commands::placement` blocking command
//! helper, exercised against real temporary directories. Mirrors the idiom
//! in `tests/store.rs` and `tests/folders.rs`.

use myna_app::commands::placement::set_meeting_placement_blocking;
use myna_app::domain::{
    effective_position, resolve_placement, FolderId, Meeting, MeetingId, Placement, RANK_GAP,
};
use myna_app::error::AppError;
use myna_app::store::fs_store::FsMeetingStore;
use myna_app::store::MeetingStore;
use time::OffsetDateTime;

fn meeting_store_at(root: &std::path::Path) -> FsMeetingStore {
    FsMeetingStore::new(root)
}

// ---- resolve_placement --------------------------------------------------

#[test]
fn resolve_placement_keeps_when_both_neighbours_are_none() {
    // Arrange
    let prev: Option<f64> = None;
    let next: Option<f64> = None;

    // Act
    let placement = resolve_placement(prev, next);

    // Assert
    assert_eq!(placement, Placement::Keep);
}

#[test]
fn resolve_placement_sets_one_gap_above_next_when_dropping_at_top() {
    // Arrange: no previous neighbour — the drop target is the very top of
    // the list.
    let next = Some(10.0);

    // Act
    let placement = resolve_placement(None, next);

    // Assert
    assert_eq!(placement, Placement::Set(10.0 - RANK_GAP));
}

#[test]
fn resolve_placement_sets_one_gap_below_prev_when_dropping_at_bottom() {
    // Arrange: no next neighbour — the drop target is the very bottom of
    // the list.
    let prev = Some(10.0);

    // Act
    let placement = resolve_placement(prev, None);

    // Assert
    assert_eq!(placement, Placement::Set(10.0 + RANK_GAP));
}

#[test]
fn resolve_placement_returns_midpoint_between_two_neighbours() {
    // Arrange
    let prev = Some(10.0);
    let next = Some(20.0);

    // Act
    let placement = resolve_placement(prev, next);

    // Assert
    assert_eq!(placement, Placement::Set(15.0));
}

#[test]
fn resolve_placement_renormalizes_when_neighbours_are_equal() {
    // Arrange
    let prev = Some(10.0);
    let next = Some(10.0);

    // Act
    let placement = resolve_placement(prev, next);

    // Assert
    assert_eq!(placement, Placement::Renormalize);
}

#[test]
fn resolve_placement_renormalizes_when_neighbours_are_inverted() {
    // Arrange: `prev` numerically greater than `next` — an inconsistent
    // pair that can only arise from a stale read racing a concurrent
    // reorder.
    let prev = Some(20.0);
    let next = Some(10.0);

    // Act
    let placement = resolve_placement(prev, next);

    // Assert
    assert_eq!(placement, Placement::Renormalize);
}

#[test]
fn resolve_placement_renormalizes_when_f64_space_is_exhausted() {
    // Arrange: the very next representable f64 value above `prev`,
    // obtained via raw bit manipulation — no midpoint is strictly between
    // two adjacent f64 values.
    let prev = 10.0_f64;
    let next = f64::from_bits(prev.to_bits() + 1);

    // Act
    let placement = resolve_placement(Some(prev), Some(next));

    // Assert: must renormalize rather than silently collapsing to `prev`
    // or `next` itself.
    assert_eq!(placement, Placement::Renormalize);
}

// ---- effective_position ---------------------------------------------------

#[test]
fn effective_position_falls_back_to_negated_created_at_seconds() {
    // Arrange
    let unplaced = Meeting::new("Unplaced meeting");

    // Act
    let effective = effective_position(&unplaced);

    // Assert
    assert_eq!(effective, -(unplaced.created_at.unix_timestamp() as f64));

    // Arrange: an explicitly placed meeting ignores `created_at` entirely.
    let placed = unplaced.with_position(Some(42.0));

    // Act
    let placed_effective = effective_position(&placed);

    // Assert
    assert_eq!(placed_effective, 42.0);
}

// ---- set_meeting_placement_blocking ---------------------------------------

#[test]
fn placement_writes_the_meeting_once_and_leaves_no_tmp_file() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let meetings = meeting_store_at(dir.path());
    let meeting = meetings.create("Needs placement").expect("create");

    // Act: archive it — a genuine change, so the single write actually
    // happens (unlike the pure no-op case in
    // `placement_is_idempotent_and_skips_the_write_when_nothing_changes`).
    let result =
        set_meeting_placement_blocking(&meetings, meeting.id, None, true, None, None, None)
            .expect("set_meeting_placement_blocking");

    // Assert
    assert!(result.archived);
    let meeting_dir = dir.path().join("meetings").join(meeting.id.to_string());
    assert!(meeting_dir.join("meeting.json").exists());
    assert!(!meeting_dir.join("meeting.json.tmp").exists());
}

#[test]
fn placement_is_idempotent_and_skips_the_write_when_nothing_changes() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let meetings = meeting_store_at(dir.path());
    let folder_id = FolderId::new();
    let created = meetings.create("Already placed").expect("create");
    let filed = created.with_folder(Some(folder_id)).with_archived(true);
    meetings.save(&filed).expect("save");
    let meeting_json_path = dir
        .path()
        .join("meetings")
        .join(filed.id.to_string())
        .join("meeting.json");
    let mtime_before = std::fs::metadata(&meeting_json_path)
        .expect("metadata before")
        .modified()
        .expect("mtime before");

    // Act: request exactly the same archived flag and folder it already
    // has, with both neighbours absent (so position is kept unchanged
    // too).
    let result = set_meeting_placement_blocking(
        &meetings,
        filed.id,
        Some(folder_id),
        true,
        None,
        None,
        None,
    )
    .expect("set_meeting_placement_blocking");

    // Assert: returns the unchanged meeting and never rewrites the file.
    assert_eq!(result, filed);
    let mtime_after = std::fs::metadata(&meeting_json_path)
        .expect("metadata after")
        .modified()
        .expect("mtime after");
    assert_eq!(mtime_before, mtime_after);
}

#[test]
fn placement_on_the_recording_meeting_yields_busy() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let meetings = meeting_store_at(dir.path());
    let recording = meetings.create("Currently recording").expect("create");

    // Act: `recording.id` is passed as both the target and the actively
    // recording meeting.
    let result = set_meeting_placement_blocking(
        &meetings,
        recording.id,
        None,
        true,
        None,
        None,
        Some(recording.id),
    );

    // Assert
    assert!(matches!(result, Err(AppError::Busy(_))));
}

#[test]
fn placement_sets_archived_folder_and_position_in_a_single_call() {
    // Arrange: a meeting that starts archived and unfiled.
    let dir = tempfile::tempdir().expect("tempdir");
    let meetings = meeting_store_at(dir.path());
    let folder_id = FolderId::new();
    let created = meetings.create("Multi-field placement").expect("create");
    let archived = created.with_archived(true);
    meetings.save(&archived).expect("save archived");

    let prev_neighbour = meetings.create("Prev neighbour").expect("create prev");
    let prev_neighbour = prev_neighbour.with_position(Some(10.0));
    meetings.save(&prev_neighbour).expect("save prev neighbour");
    let next_neighbour = meetings.create("Next neighbour").expect("create next");
    let next_neighbour = next_neighbour.with_position(Some(20.0));
    meetings.save(&next_neighbour).expect("save next neighbour");

    // Act: unarchive, refile into `folder_id`, and drop it between the
    // two neighbours — all in one call.
    let result = set_meeting_placement_blocking(
        &meetings,
        archived.id,
        Some(folder_id),
        false,
        Some(prev_neighbour.id),
        Some(next_neighbour.id),
        None,
    )
    .expect("set_meeting_placement_blocking");

    // Assert: all three target fields land together, in a single call.
    assert!(!result.archived);
    assert_eq!(result.folder_id, Some(folder_id));
    assert_eq!(result.position, Some(15.0));

    let refetched = meetings.get(archived.id).expect("get after placement");
    assert_eq!(refetched, result);
}

#[test]
fn placement_treats_an_unknown_neighbour_id_as_none_rather_than_erroring() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let meetings = meeting_store_at(dir.path());
    let meeting = meetings.create("Target").expect("create");
    let next_neighbour = meetings.create("Real next neighbour").expect("create next");
    let next_neighbour = next_neighbour.with_position(Some(10.0));
    meetings.save(&next_neighbour).expect("save next neighbour");
    let dangling_id = MeetingId::new();

    // Act: `dangling_id` names no meeting that exists — it must resolve
    // to `None`, not an error.
    let result = set_meeting_placement_blocking(
        &meetings,
        meeting.id,
        None,
        false,
        Some(dangling_id),
        Some(next_neighbour.id),
        None,
    )
    .expect("an unknown previous_id must not error");

    // Assert: behaves exactly as if `previous_id` had been `None` —
    // (None, Some(10.0)) resolves to Set(10.0 - RANK_GAP).
    assert_eq!(result.position, Some(10.0 - RANK_GAP));
}

#[test]
fn placement_next_to_the_recording_meeting_succeeds() {
    // Arrange: a currently-recording meeting acts as one neighbour. A
    // dense (index-based) reindex scheme would need to rewrite the
    // recording meeting's own row to shift indices — which
    // `guard_not_recording` would then have to forbid, deadlocking any
    // reorder next to an active recording. Fractional ranks sidestep
    // that: the recording meeting's own position is only *read*, never
    // written.
    let dir = tempfile::tempdir().expect("tempdir");
    let meetings = meeting_store_at(dir.path());
    let recording = meetings.create("Currently recording").expect("create");
    let recording = recording.with_position(Some(10.0));
    meetings.save(&recording).expect("save recording position");
    let target = meetings.create("Being reordered").expect("create target");

    // Act: drop `target` directly below the recording meeting (as
    // `prev`), with no `next` neighbour, while the recording meeting is
    // the active session.
    let result = set_meeting_placement_blocking(
        &meetings,
        target.id,
        None,
        false,
        Some(recording.id),
        None,
        Some(recording.id),
    )
    .expect("placement next to a recording meeting must succeed");

    // Assert: the target's own position is set; the recording meeting is
    // untouched.
    assert_eq!(result.position, Some(10.0 + RANK_GAP));
    let refetched_recording = meetings.get(recording.id).expect("get recording");
    assert_eq!(refetched_recording.position, Some(10.0));
    assert!(!refetched_recording.archived);
}

#[test]
fn placement_renormalizes_when_two_unplaced_meetings_share_a_created_at_second() {
    // Arrange: two unplaced meetings that share the same `created_at`
    // instant — their negated-timestamp effective positions collide
    // exactly, so placing a third meeting between them can't compute a
    // midpoint without renormalizing first.
    let dir = tempfile::tempdir().expect("tempdir");
    let meetings = meeting_store_at(dir.path());
    let same_instant = OffsetDateTime::now_utc();
    let a = Meeting {
        created_at: same_instant,
        ..Meeting::new("A")
    };
    let b = Meeting {
        created_at: same_instant,
        ..Meeting::new("B")
    };
    meetings.save(&a).expect("save a");
    meetings.save(&b).expect("save b");
    let c = meetings.create("C").expect("create c");

    // Act: place C between A and B — their equal effective positions
    // force a renormalize-and-retry.
    let result =
        set_meeting_placement_blocking(&meetings, c.id, None, false, Some(a.id), Some(b.id), None)
            .expect("renormalize-and-retry must still succeed");

    // Assert: C lands strictly between A and B's now-renormalized,
    // distinct positions (order between A and B is not asserted, since
    // renormalize's own tie-break order is an implementation detail).
    let refetched_a = meetings.get(a.id).expect("get a");
    let refetched_b = meetings.get(b.id).expect("get b");
    let a_position = refetched_a
        .position
        .expect("a should be given an explicit position by renormalize");
    let b_position = refetched_b
        .position
        .expect("b should be given an explicit position by renormalize");
    let (lower, upper) = if a_position < b_position {
        (a_position, b_position)
    } else {
        (b_position, a_position)
    };
    let c_position = result.position.expect("c should have an explicit position");
    assert!(lower < c_position && c_position < upper);
}
