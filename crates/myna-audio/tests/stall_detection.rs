//! Tests for the system-audio stall-detection policy.
//!
//! Everything here is deterministic: no real audio device, no Core Audio
//! HAL round-trip, and no `sleep` — durations and simulated `Instant`s are
//! passed in directly.
//!
//! These pin down the fix for a false-positive regression: before it,
//! `is_any_tapped_process_rendering_output` reusing the same 2s
//! [`SYSTEM_STALL_TIMEOUT`] used for the no-callback case meant any
//! ordinary few-second pause in conversation — while a video-call app still
//! holds an active output session — triggered a full tap teardown and
//! rebuild mid-meeting. See `is_system_audio_stalled`'s doc comment for the
//! two-timeout policy that replaces it.

use std::time::{Duration, Instant};

use myna_audio::{
    is_system_audio_stalled, RateLimitedQuery, RENDERING_QUERY_MIN_INTERVAL,
    SYSTEM_RENDERING_SILENCE_TIMEOUT, SYSTEM_STALL_TIMEOUT,
};

#[test]
fn ordinary_conversational_silence_while_rendering_does_not_stall() {
    // Arrange: system-audio callbacks are still arriving on schedule — no
    // no-callback stall — but samples have been all-zero for a bit longer
    // than SYSTEM_STALL_TIMEOUT, an entirely ordinary pause in
    // conversation, while the tapped process still reports an active
    // output session.
    let since_last_callback = Duration::from_millis(50);
    let since_last_nonzero = SYSTEM_STALL_TIMEOUT + Duration::from_secs(1);

    // Act
    let stalled = is_system_audio_stalled(since_last_callback, since_last_nonzero, true);

    // Assert
    assert!(
        !stalled,
        "an ordinary pause under the rendering-silence timeout must never trigger a rebuild"
    );
}

#[test]
fn no_callback_at_all_still_stalls_even_when_not_rendering() {
    // Arrange: the genuine "tap died outright" case — no callback for
    // longer than SYSTEM_STALL_TIMEOUT at all.
    let since_last_callback = SYSTEM_STALL_TIMEOUT + Duration::from_millis(1);
    let since_last_nonzero = SYSTEM_STALL_TIMEOUT + Duration::from_millis(1);

    // Act
    let stalled = is_system_audio_stalled(since_last_callback, since_last_nonzero, false);

    // Assert
    assert!(
        stalled,
        "a genuinely dead tap (no callback at all) must still trigger a rebuild"
    );
}

#[test]
fn silence_past_the_rendering_timeout_while_rendering_stalls() {
    // Arrange: callbacks are still arriving, but samples have been silent
    // for well past the long rendering-silence window while the process
    // still reports rendering — this is the Core Audio process-tap failure
    // mode the second trigger exists for.
    let since_last_callback = Duration::from_millis(50);
    let since_last_nonzero = SYSTEM_RENDERING_SILENCE_TIMEOUT + Duration::from_secs(1);

    // Act
    let stalled = is_system_audio_stalled(since_last_callback, since_last_nonzero, true);

    // Assert
    assert!(stalled);
}

#[test]
fn silence_past_stall_timeout_but_not_rendering_does_not_stall() {
    // Arrange: the tapped process is no longer reported as rendering (e.g.
    // it quit), callbacks are still arriving, and it's been silent for
    // longer than the short timeout but not the long one — neither trigger
    // should fire.
    let since_last_callback = Duration::from_millis(50);
    let since_last_nonzero = SYSTEM_STALL_TIMEOUT + Duration::from_secs(1);

    // Act
    let stalled = is_system_audio_stalled(since_last_callback, since_last_nonzero, false);

    // Assert
    assert!(!stalled);
}

#[test]
fn rate_limited_query_refreshes_on_the_first_call() {
    // Arrange
    let mut query = RateLimitedQuery::new(RENDERING_QUERY_MIN_INTERVAL);

    // Act
    let value = query.get(Instant::now(), || true);

    // Assert
    assert!(value);
}

#[test]
fn rate_limited_query_never_refreshes_more_than_once_per_interval() {
    // Arrange
    let mut query = RateLimitedQuery::new(RENDERING_QUERY_MIN_INTERVAL);
    let start = Instant::now();
    let mut refresh_count = 0;

    // Act: the first call always refreshes; the second, well inside the
    // interval, must reuse the cached value without invoking `query` again.
    let first = query.get(start, || {
        refresh_count += 1;
        true
    });
    let second = query.get(start + Duration::from_millis(100), || {
        refresh_count += 1;
        false
    });

    // Assert
    assert!(first);
    assert!(
        second,
        "expected the cached value from the first refresh, not a fresh (different) result"
    );
    assert_eq!(
        refresh_count, 1,
        "expected exactly one refresh for two calls inside the same interval"
    );

    // Act: once the interval has fully elapsed, the next call refreshes.
    let third = query.get(start + RENDERING_QUERY_MIN_INTERVAL, || {
        refresh_count += 1;
        false
    });

    // Assert
    assert!(!third);
    assert_eq!(refresh_count, 2);
}
