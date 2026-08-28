//! Summarization commands: streaming inference with cancellation, backed by
//! the cached [`myna_llm::Summarizer`] in [`AppState`].
//!
//! `summarize_meeting` and `get_summary` are `async fn`s that hand their
//! blocking work to [`tauri::async_runtime::spawn_blocking`] so Tauri's IPC
//! dispatcher runs them on the async runtime's blocking-pool threads
//! instead of the main thread — see the module-level note in
//! `crate::commands` for why this matters. The busy guard
//! ([`AppState::begin_summarization`]/[`AppState::end_summarization`]) is
//! still taken synchronously, before any `.await`, so it is never held
//! across one.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};
use time::OffsetDateTime;

use myna_llm::{resolve, RenderContext, SummaryOptions, Template};

use crate::domain::{Meeting, MeetingId, Summary, SummaryRef};
use crate::dto::SummaryDto;
use crate::error::AppError;
use crate::events::{SummaryDonePayload, TokenPayload, SUMMARY_DONE, SUMMARY_TOKEN};
use crate::paths;
use crate::state::AppState;
use crate::store::MeetingStore;

/// Seconds in one minute, used by [`format_duration`].
const SECONDS_PER_MINUTE: u32 = 60;
/// Seconds in one hour, used by [`format_duration`].
const SECONDS_PER_HOUR: u32 = SECONDS_PER_MINUTE * 60;

/// Renders `meeting_id`'s transcript through `template` in `language`,
/// streaming tokens via [`SUMMARY_TOKEN`] as they generate, then persists
/// and returns the finished summary.
///
/// `language` is validated against `myna_llm`'s supported language list via
/// [`resolve`]; `None` or an unrecognized code falls back to the default
/// rather than erroring.
///
/// Fails with [`AppError::Busy`] if a summarization is already running.
///
/// `async fn`: the actual generation runs inside
/// [`tauri::async_runtime::spawn_blocking`] (see [`run_summarization`]), so
/// this command never occupies the main thread for the seconds-to-minutes
/// an LLM generation can take — that main-thread stall was the reported bug
/// ("the whole application is frozen during the generation runtime").
/// [`AppState::begin_summarization`]/[`AppState::end_summarization`] bracket
/// the spawned work but are called directly on this async fn's own
/// execution, never inside the blocking closure, so no lock or guard state
/// is held across the `.await`.
#[tauri::command]
pub async fn summarize_meeting(
    app: AppHandle,
    meeting_id: String,
    template: String,
    language: Option<String>,
) -> Result<SummaryDto, AppError> {
    let id = parse_meeting_id(&meeting_id)?;
    app.state::<AppState>().begin_summarization()?;

    let app_for_worker = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app_for_worker.state::<AppState>();
        run_summarization(&app_for_worker, &state, id, template, language)
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Store(
            "summarization worker thread panicked".to_string(),
        ))
    });

    app.state::<AppState>().end_summarization();
    result
}

/// Reads a previously persisted summary's markdown for a meeting/template/
/// language triple from `store`, if one exists.
///
/// Extracted as a function over `&dyn MeetingStore` (rather than
/// `State<AppState>`) so it is unit-testable against a
/// `tempfile::tempdir()`-backed `FsMeetingStore` without a Tauri app
/// context — mirrors [`crate::commands::models::models_status_at`].
///
/// Returns `Ok(None)` when `id` resolves to a known meeting that simply has
/// no saved summary for the (`template`, `language`) pair — a normal
/// state, not a failure. That is the fix for summaries appearing to vanish
/// after a restart: the markdown lives on disk (`read_summary` reads it
/// back), it was just never reachable from the UI before this command
/// existed.
///
/// Fails with [`AppError::NotFound`] when `id` itself does not resolve to
/// any meeting. `template` and `language` are user-influenced strings used
/// to build a filesystem path, so they are passed straight through to
/// [`MeetingStore::read_summary`], which sanitizes each into a single safe
/// path segment exactly as `save_summary` does — a value such as
/// `"../../etc/passwd"` cannot escape the meeting directory; it simply
/// fails to match any saved summary and reads as `Ok(None)`.
pub fn get_summary_from(
    store: &dyn MeetingStore,
    id: MeetingId,
    template: &str,
    language: &str,
) -> Result<Option<SummaryDto>, AppError> {
    store.get(id)?;

    match store.read_summary(id, template, language) {
        Ok(summary) => Ok(Some(SummaryDto::from(summary))),
        Err(AppError::NotFound(_)) => Ok(None),
        Err(err) => Err(err),
    }
}

/// Reads a meeting's persisted summary markdown for `template` and
/// `language`, if one has been saved. See [`get_summary_from`] for the
/// full contract.
///
/// `async fn`: a meeting store can grow to hold many meetings' worth of
/// summaries, so the read is dispatched to
/// [`tauri::async_runtime::spawn_blocking`] rather than assumed to always
/// be microseconds-scale on the main thread.
#[tauri::command]
pub async fn get_summary(
    app: AppHandle,
    meeting_id: String,
    template: String,
    language: String,
) -> Result<Option<SummaryDto>, AppError> {
    let id = parse_meeting_id(&meeting_id)?;
    let store = Arc::clone(&app.state::<AppState>().store);

    tauri::async_runtime::spawn_blocking(move || {
        get_summary_from(store.as_ref(), id, &template, &language)
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Store(
            "get_summary worker thread panicked".to_string(),
        ))
    })
}

/// Requests cancellation of the in-flight summarization, if any.
///
/// The running [`myna_llm::Summarizer::summarize`] call observes the shared
/// flag and returns [`myna_llm::LlmError::Cancelled`], which surfaces to
/// the UI as an [`AppError::Llm`] with code `"LLM"`.
///
/// Stays synchronous: a single [`std::sync::atomic::AtomicBool`] store is
/// microseconds-scale and does no I/O, so there is nothing to move off the
/// main thread.
#[tauri::command]
pub fn cancel_summarization(state: State<'_, AppState>) {
    state.cancel_summary.store(true, Ordering::SeqCst);
}

/// Does the actual work of [`summarize_meeting`], factored out so the
/// caller can unconditionally release the busy flag afterwards regardless
/// of outcome.
fn run_summarization(
    app: &AppHandle,
    state: &State<'_, AppState>,
    id: MeetingId,
    template_name: String,
    language: Option<String>,
) -> Result<SummaryDto, AppError> {
    let (language_code, language_label) = resolve(language.as_deref());

    let meeting = state.store.get(id)?;
    let template = load_template(app, &template_name)?;
    let prompt = render_prompt(&meeting, &template, language_label)?;
    let summarizer = state.summarizer(app)?;

    let markdown = run_inference(app, state, &id, &template_name, prompt, summarizer)?;

    let created_at = OffsetDateTime::now_utc();
    let path = state
        .store
        .save_summary(id, &template_name, language_code, &markdown)?;
    let updated = meeting.with_summary(SummaryRef {
        template: template_name.clone(),
        created_at,
        path,
        language: language_code.to_string(),
    });
    state.store.save(&updated)?;

    emit_done(
        app,
        &id.to_string(),
        &template_name,
        language_code,
        &markdown,
    );

    Ok(SummaryDto::from(Summary {
        template: template_name,
        markdown,
        created_at,
        language: language_code.to_string(),
    }))
}

/// Runs the blocking `Summarizer::summarize` call, streaming each generated
/// token back to the UI via [`SUMMARY_TOKEN`].
///
/// Called from inside the [`tauri::async_runtime::spawn_blocking`] closure
/// in [`summarize_meeting`], so this already executes on a dedicated
/// blocking-pool thread — no further `thread::spawn` is needed here (unlike
/// before this module's async conversion, when this was the only thing
/// keeping the call off the caller's thread).
fn run_inference(
    app: &AppHandle,
    state: &State<'_, AppState>,
    id: &MeetingId,
    template_name: &str,
    prompt: String,
    summarizer: Arc<myna_llm::Summarizer>,
) -> Result<String, AppError> {
    let cancel = Arc::clone(&state.cancel_summary);
    let meeting_id_str = id.to_string();

    let markdown = summarizer.summarize(&prompt, &SummaryOptions::default(), &cancel, |token| {
        emit_token(app, &meeting_id_str, template_name, token);
    })?;

    Ok(markdown)
}

/// Loads `template_name` from the templates root by discovering every valid
/// template rather than trusting the name as a path segment.
fn load_template(app: &AppHandle, template_name: &str) -> Result<Template, AppError> {
    myna_llm::list_templates(&paths::templates_root(app))?
        .into_iter()
        .find(|candidate| candidate.name == template_name)
        .ok_or_else(|| AppError::NotFound(format!("template '{template_name}'")))
}

/// Builds the render context from `meeting`'s transcript and the resolved
/// output language, and renders `template`'s prompt, failing if the meeting
/// has no transcript yet.
fn render_prompt(
    meeting: &Meeting,
    template: &Template,
    language_label: &str,
) -> Result<String, AppError> {
    let transcript = meeting
        .transcript
        .as_ref()
        .ok_or_else(|| AppError::NotFound(format!("transcript for meeting {}", meeting.id)))?;

    let ctx = RenderContext {
        transcript: transcript.full_text(),
        duration: format_duration(meeting.duration_sec),
        title: meeting.title.clone(),
        language: language_label.to_string(),
    };
    Ok(template.render(&ctx))
}

/// Formats `duration_sec` as `M:SS`, or `H:MM:SS` once past an hour.
fn format_duration(duration_sec: f32) -> String {
    let total_seconds = duration_sec.max(0.0).round() as u32;
    let hours = total_seconds / SECONDS_PER_HOUR;
    let minutes = (total_seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE;
    let seconds = total_seconds % SECONDS_PER_MINUTE;

    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

fn emit_token(app: &AppHandle, meeting_id: &str, template: &str, token: &str) {
    let payload = TokenPayload {
        meeting_id: meeting_id.to_string(),
        template: template.to_string(),
        token: token.to_string(),
    };
    let _ = app.emit(SUMMARY_TOKEN, payload);
}

fn emit_done(app: &AppHandle, meeting_id: &str, template: &str, language: &str, markdown: &str) {
    let payload = SummaryDonePayload {
        meeting_id: meeting_id.to_string(),
        template: template.to_string(),
        language: language.to_string(),
        markdown: markdown.to_string(),
    };
    let _ = app.emit(SUMMARY_DONE, payload);
}

/// Parses a meeting id from its string form, surfacing an invalid id as
/// [`AppError::NotFound`] rather than a parse error.
fn parse_meeting_id(id: &str) -> Result<MeetingId, AppError> {
    id.parse().map_err(|_| AppError::NotFound(id.to_string()))
}
