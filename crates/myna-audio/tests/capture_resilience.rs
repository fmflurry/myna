//! Contract tests for the cancellable system-audio supervisor.
//!
//! These are deliberately hardware-free. The public supervisor is expected to
//! receive every HAL operation as a safe, injectable closure, so its deadline,
//! cancellation, generation, and callback-boundary behaviour can be proved
//! without Core Audio or a live device.

use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc, Arc, Barrier,
};
use std::thread;
use std::time::{Duration, Instant};

use myna_audio::{
    SystemAudioAttachment, SystemAudioSupervisor, SystemAudioSupervisorConfig,
    SystemAudioSupervisorHooks, SystemAudioSupervisorStatus,
};

const DEADLINE: Duration = Duration::from_millis(100);
const TEST_WAIT: Duration = Duration::from_secs(1);

fn supervisor(
    query_hal: impl Fn() -> bool + Send + Sync + 'static,
    rebuild: impl Fn(&myna_audio::SupervisorCancellation) -> SystemAudioAttachment
        + Send
        + Sync
        + 'static,
    status: impl Fn(SystemAudioSupervisorStatus) + Send + Sync + 'static,
) -> SystemAudioSupervisor {
    SystemAudioSupervisor::start(
        SystemAudioSupervisorConfig { deadline: DEADLINE },
        SystemAudioSupervisorHooks::new(query_hal, rebuild, status),
    )
}

#[test]
fn cancellation_stops_a_waiting_rebuild_within_the_deadline_without_killing_its_thread() {
    let rebuild_started = Arc::new(Barrier::new(2));
    let rebuild_finished = Arc::new(AtomicBool::new(false));
    let worker_was_cancelled = Arc::new(AtomicBool::new(false));
    let started = Arc::clone(&rebuild_started);
    let finished = Arc::clone(&rebuild_finished);
    let cancelled = Arc::clone(&worker_was_cancelled);
    let supervisor = supervisor(
        || true,
        move |cancellation| {
            started.wait();
            cancellation.wait_cancelled();
            cancelled.store(cancellation.is_cancelled(), Ordering::SeqCst);
            finished.store(true, Ordering::SeqCst);
            SystemAudioAttachment::new(|| {})
        },
        |_| {},
    );

    supervisor.request_rebuild();
    rebuild_started.wait();

    let began = Instant::now();
    let outcome = supervisor.cancel_and_wait();

    assert!(outcome.completed_within(DEADLINE));
    assert!(began.elapsed() <= DEADLINE + Duration::from_millis(50));
    assert!(rebuild_finished.load(Ordering::SeqCst));
    assert!(worker_was_cancelled.load(Ordering::SeqCst));
}

#[test]
fn concurrent_stall_notifications_coalesce_to_one_rebuild() {
    let rebuild_started = Arc::new(Barrier::new(2));
    let release_rebuild = Arc::new(Barrier::new(2));
    let rebuilds = Arc::new(AtomicUsize::new(0));
    let started = Arc::clone(&rebuild_started);
    let release = Arc::clone(&release_rebuild);
    let count = Arc::clone(&rebuilds);
    let supervisor = Arc::new(supervisor(
        || true,
        move |_| {
            count.fetch_add(1, Ordering::SeqCst);
            started.wait();
            release.wait();
            SystemAudioAttachment::new(|| {})
        },
        |_| {},
    ));

    let callers = (0..16)
        .map(|_| {
            let supervisor = Arc::clone(&supervisor);
            thread::spawn(move || supervisor.request_rebuild())
        })
        .collect::<Vec<_>>();
    rebuild_started.wait();
    release_rebuild.wait();
    for caller in callers {
        caller
            .join()
            .expect("stall notification thread must not panic");
    }

    assert!(supervisor.wait_for_idle(TEST_WAIT));
    assert_eq!(rebuilds.load(Ordering::SeqCst), 1);
    assert!(supervisor.cancel_and_wait().completed_within(DEADLINE));
}

#[test]
fn attach_deadline_expiry_is_reported_as_status() {
    let (statuses_sent, statuses_received) = mpsc::channel();
    let supervisor = supervisor(
        || true,
        move |cancellation| {
            cancellation.wait_cancelled();
            SystemAudioAttachment::new(|| {})
        },
        move |status| {
            statuses_sent
                .send(status)
                .expect("test status receiver is alive")
        },
    );

    supervisor.request_rebuild();
    assert_eq!(
        statuses_received
            .recv_timeout(TEST_WAIT)
            .expect("attach deadline status"),
        SystemAudioSupervisorStatus::AttachTimedOut
    );
    assert!(supervisor.cancel_and_wait().completed_within(DEADLINE));
}

#[test]
fn teardown_deadline_expiry_is_reported_as_status() {
    let (statuses_sent, statuses_received) = mpsc::channel();
    let attachment_stop_started = Arc::new(Barrier::new(2));
    let stop_started = Arc::clone(&attachment_stop_started);
    let supervisor = supervisor(
        || true,
        move |_| {
            let stop_started = Arc::clone(&stop_started);
            SystemAudioAttachment::new(move || stop_started.wait())
        },
        move |status| {
            statuses_sent
                .send(status)
                .expect("test status receiver is alive")
        },
    );

    supervisor.request_rebuild();
    assert!(supervisor.wait_for_idle(TEST_WAIT));
    let cancellation = supervisor.cancel();
    attachment_stop_started.wait();
    assert_eq!(
        statuses_received
            .recv_timeout(TEST_WAIT)
            .expect("teardown deadline status"),
        SystemAudioSupervisorStatus::TeardownTimedOut
    );
    assert!(cancellation.wait_for_completion(TEST_WAIT));
}

#[test]
fn attachment_returned_after_cancellation_is_stopped_and_never_published() {
    let rebuild_started = Arc::new(Barrier::new(2));
    let release_late_result = Arc::new(Barrier::new(2));
    let stopped = Arc::new(AtomicBool::new(false));
    let started = Arc::clone(&rebuild_started);
    let release = Arc::clone(&release_late_result);
    let stopped_by_supervisor = Arc::clone(&stopped);
    let supervisor = supervisor(
        || true,
        move |_| {
            started.wait();
            release.wait();
            let stopped_by_supervisor = Arc::clone(&stopped_by_supervisor);
            SystemAudioAttachment::new(move || stopped_by_supervisor.store(true, Ordering::SeqCst))
        },
        |_| {},
    );

    supervisor.request_rebuild();
    rebuild_started.wait();
    let cancelled = supervisor.cancel();
    release_late_result.wait();

    assert!(cancelled.wait_for_completion(TEST_WAIT));
    assert!(stopped.load(Ordering::SeqCst));
    assert!(supervisor.current_attachment().is_none());
}

#[test]
fn hal_query_runs_on_the_supervisor_worker_never_the_callback_calling_thread() {
    let (queried_sent, queried_received) = mpsc::channel();
    let callback_thread = thread::current().id();
    let supervisor = supervisor(
        move || {
            queried_sent
                .send(thread::current().id())
                .expect("test receiver is alive");
            true
        },
        |_| SystemAudioAttachment::new(|| {}),
        |_| {},
    );

    supervisor.notify_audio_callback();

    let query_thread = queried_received
        .recv_timeout(TEST_WAIT)
        .expect("background HAL query");
    assert_ne!(query_thread, callback_thread);
    assert!(supervisor.cancel_and_wait().completed_within(DEADLINE));
}
