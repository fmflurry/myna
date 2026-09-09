//! Diarization-judge prompt: constrained index-to-label mapping for VAD
//! segments, rendered from `templates/diarize-judge.json`'s placeholders.
//!
//! The judge runs on the local [`Summarizer`](myna_llm::Summarizer) only
//! (temperature [`DIARIZE_JUDGE_TEMPERATURE`], max tokens
//! [`DIARIZE_JUDGE_MAX_TOKENS`]) and returns nothing but
//! `{"labels": {idx: label}}` — never transcript text. It is deliberately
//! not a summary template: its placeholders (`{num_speakers}`,
//! `{segments_json}`, `{diar_json}`) are outside the summary-template
//! placeholder set, so `myna-llm` discovery skips the JSON file by design
//! and this module renders it directly.
//!
//! [`validate_judge_output`] is the fail-closed gate between the judge's raw
//! string output and any relabeling: anything that is not exactly the
//! labels object is rejected, and missing indices fall back to bare
//! [`Speaker::others`]. The text-lock hash gate
//! (`verify_full_text_locked`) already lives in
//! `crate::commands::import` — it is not duplicated here.

use myna_stt::{Speaker, SpeakerRole, Transcript};

use crate::error::AppError;

/// Environment variable gating the diarization-judge pass. The judge never
/// runs unless this is exactly `"1"` — default OFF, no auto-run change.
pub const DIARIZE_JUDGE_ENV_VAR: &str = "MYNA_DIARIZE_JUDGE";

/// Returns whether the diarization-judge pass is enabled
/// (`MYNA_DIARIZE_JUDGE == "1"`, default `false` when unset or any other
/// value).
pub fn is_judge_enabled() -> bool {
    std::env::var(DIARIZE_JUDGE_ENV_VAR)
        .map(|value| value == "1")
        .unwrap_or(false)
}

/// Applies already-validated judge labels to `transcript`, returning a new
/// [`Transcript`] that swaps only the `speaker` field per segment index.
///
/// Text, timing (`start_sec`/`end_sec`), and every other field are preserved
/// by construction (each output segment starts as a clone of the input).
/// Segments with `speaker_pinned == true` — the user's manual corrections —
/// keep their existing speaker and are never overwritten. Indices beyond
/// `validated_speakers.len()` keep their existing speaker (fail-soft for a
/// short judge output); extra labels beyond the transcript length are
/// ignored.
pub fn apply_judge_labels(transcript: &Transcript, validated_speakers: &[Speaker]) -> Transcript {
    Transcript {
        segments: transcript
            .segments
            .iter()
            .enumerate()
            .map(|(index, segment)| {
                let mut out = segment.clone();
                if !segment.speaker_pinned {
                    if let Some(label) = validated_speakers.get(index) {
                        out.speaker = label.clone();
                    }
                }
                out
            })
            .collect(),
    }
}

/// Template id; matches `templates/diarize-judge.json`'s `name` field.
pub const DIARIZE_JUDGE_TEMPLATE_NAME: &str = "diarize-judge";

/// Sampling temperature for the judge call: fully deterministic output.
pub const DIARIZE_JUDGE_TEMPERATURE: f32 = 0.0;

/// Generation cap for the judge call: the labels object is tiny.
pub const DIARIZE_JUDGE_MAX_TOKENS: u32 = 256;

/// Judge prompt, mirroring `templates/diarize-judge.json`'s `prompt`.
/// Placeholders: `{num_speakers}`, `{segments_json}`, `{diar_json}`.
pub const DIARIZE_JUDGE_PROMPT: &str = r#"You are a speaker-label judge for a meeting recording. There are {num_speakers} remote speaker(s) in addition to the local user. You are given VAD speech segments and a diarization hypothesis below. Assign every segment index exactly one label: "others" when there is a single remote speaker, or one of "others:1" through "others:{num_speakers}" when there are several. Return ONLY the JSON object {"labels": {"<segment index>": "<label>"}} with one entry per segment index. No transcript text, no explanation, no markdown, no extra keys.

Segments:
{segments_json}

Diarization hypothesis:
{diar_json}

Labels JSON:"#;

/// Render [`DIARIZE_JUDGE_PROMPT`] by substituting the three judge
/// placeholders. `segments_json` and `diar_json` are pre-serialized JSON
/// payloads; the label value set depends on `num_speakers` (`others` for a
/// single remote speaker, `others:1..N` otherwise).
pub fn render_diarize_judge_prompt(
    num_speakers: u32,
    segments_json: &str,
    diar_json: &str,
) -> String {
    DIARIZE_JUDGE_PROMPT
        .replace("{num_speakers}", &num_speakers.to_string())
        .replace("{segments_json}", segments_json)
        .replace("{diar_json}", diar_json)
}

/// Fail-closed validator for the judge's raw string output.
///
/// Accepts exactly `{"labels": {"<idx>": "<label>"}}` and returns one
/// [`Speaker`] per segment index (`0..num_segments`). Rejects:
/// leading/trailing prose (after trimming the output must start with `{`
/// and end with `}`), malformed JSON, unknown top-level keys, a missing or
/// non-object `labels` value, non-numeric or out-of-range indices, non-string
/// labels, and labels that are not bare `others` / `others:1..=num_speakers`
/// (checked via [`Speaker::parse`] round-trip plus [`Speaker::role`] plus
/// the numeric range, so `others:99` with `num_speakers == 2` fails).
/// Indices absent from `labels` — including the empty-labels case
/// (`{"labels": {}}`) — fall back to bare [`Speaker::others`].
pub fn validate_judge_output(
    raw: &str,
    num_segments: usize,
    num_speakers: u32,
) -> Result<Vec<Speaker>, AppError> {
    let trimmed = raw.trim();
    if !(trimmed.starts_with('{') && trimmed.ends_with('}')) {
        return Err(AppError::Store(
            "diarize judge output must be exactly a JSON object; refusing to relabel".to_string(),
        ));
    }
    let value: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|err| AppError::Store(format!("diarize judge output is not valid JSON: {err}")))?;
    let obj = value.as_object().ok_or_else(|| {
        AppError::Store(
            "diarize judge output must be a JSON object; refusing to relabel".to_string(),
        )
    })?;
    if obj.len() != 1 || !obj.contains_key("labels") {
        return Err(AppError::Store(
            "diarize judge output must contain exactly the \"labels\" key; refusing to relabel"
                .to_string(),
        ));
    }
    let labels = obj.get("labels").unwrap_or(&serde_json::Value::Null);
    let map = labels.as_object().ok_or_else(|| {
        AppError::Store(
            "diarize judge \"labels\" must be an object of index to label; refusing to relabel"
                .to_string(),
        )
    })?;

    let mut out = vec![Speaker::others(); num_segments];
    for (key, val) in map {
        let idx: usize = key.parse().map_err(|_| {
            AppError::Store(format!(
                "diarize judge label index {key:?} is not a segment index; refusing to relabel"
            ))
        })?;
        if idx >= num_segments {
            return Err(AppError::Store(format!(
                "diarize judge label index {idx} is out of range for {num_segments} segments; refusing to relabel"
            )));
        }
        let label = val.as_str().ok_or_else(|| {
            AppError::Store(format!(
                "diarize judge label for segment {idx} must be a string; refusing to relabel"
            ))
        })?;
        let parsed = Speaker::parse(label);
        if parsed.as_str() != label {
            return Err(AppError::Store(format!(
                "diarize judge label {label:?} for segment {idx} is malformed; refusing to relabel"
            )));
        }
        if parsed.role() != SpeakerRole::Others {
            return Err(AppError::Store(format!(
                "diarize judge label {label:?} for segment {idx} must be an \"others\" label; refusing to relabel"
            )));
        }
        if let Some(sub_id) = parsed.sub_id() {
            let n: u32 = sub_id.parse().map_err(|_| {
                AppError::Store(format!(
                    "diarize judge label {label:?} for segment {idx} is not a numbered \"others\" label; refusing to relabel"
                ))
            })?;
            if sub_id != n.to_string() || n < 1 || n > num_speakers {
                return Err(AppError::Store(format!(
                    "diarize judge label {label:?} for segment {idx} is out of range for {num_speakers} speaker(s); refusing to relabel"
                )));
            }
        }
        out[idx] = parsed;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_substitutes_all_placeholders_with_no_tokens_left() {
        // Arrange
        let segments_json = r#"[{"index":0,"start":0.0,"end":1.2}]"#;
        let diar_json = r#"{"spk0":[0]}"#;

        // Act
        let rendered = render_diarize_judge_prompt(2, segments_json, diar_json);

        // Assert
        assert!(rendered.contains("There are 2 remote speaker(s)"));
        assert!(rendered.contains(segments_json));
        assert!(rendered.contains(diar_json));
        assert!(!rendered.contains("{num_speakers}"));
        assert!(!rendered.contains("{segments_json}"));
        assert!(!rendered.contains("{diar_json}"));
        assert!(rendered.contains(r#"{"labels": {"<segment index>": "<label>"}}"#));
    }

    #[test]
    fn valid_numbered_labels_pass() {
        let out = validate_judge_output(r#"{"labels": {"0": "others:1", "1": "others:2"}}"#, 2, 2)
            .expect("valid judge output must pass");
        assert_eq!(out, vec![Speaker::others_id("1"), Speaker::others_id("2")]);
    }

    #[test]
    fn valid_bare_others_passes_for_single_speaker() {
        let out = validate_judge_output(r#"{"labels": {"0": "others"}}"#, 1, 1)
            .expect("bare others must pass for a single speaker");
        assert_eq!(out, vec![Speaker::others()]);
    }

    #[test]
    fn trailing_prose_fails() {
        assert!(
            validate_judge_output(r#"{"labels": {"0": "others"}} extra"#, 1, 1).is_err(),
            "trailing prose must fail"
        );
        assert!(
            validate_judge_output(r#"Here you go: {"labels": {"0": "others"}}"#, 1, 1).is_err(),
            "leading prose must fail"
        );
    }

    #[test]
    fn bad_index_fails() {
        assert!(
            validate_judge_output(r#"{"labels": {"abc": "others"}}"#, 1, 1).is_err(),
            "non-numeric index must fail"
        );
        assert!(
            validate_judge_output(r#"{"labels": {"5": "others"}}"#, 2, 1).is_err(),
            "out-of-range index must fail"
        );
    }

    #[test]
    fn others_99_with_two_speakers_fails() {
        assert!(
            validate_judge_output(r#"{"labels": {"0": "others:99"}}"#, 1, 2).is_err(),
            "others:99 with N=2 must fail"
        );
    }

    #[test]
    fn empty_labels_yield_all_bare_others() {
        let out = validate_judge_output(r#"{"labels": {}}"#, 3, 2).expect("empty labels must pass");
        assert_eq!(
            out,
            vec![Speaker::others(), Speaker::others(), Speaker::others()]
        );
    }

    #[test]
    fn unknown_top_level_key_fails() {
        assert!(
            validate_judge_output(r#"{"labels": {}, "extra": 1}"#, 0, 1).is_err(),
            "unknown top-level keys must fail"
        );
    }

    #[test]
    fn missing_index_falls_back_to_bare_others() {
        let out = validate_judge_output(r#"{"labels": {"0": "others:1"}}"#, 2, 2)
            .expect("missing index must fall back, not fail");
        assert_eq!(out, vec![Speaker::others_id("1"), Speaker::others()]);
    }

    #[test]
    fn non_others_label_fails() {
        assert!(
            validate_judge_output(r#"{"labels": {"0": "me"}}"#, 1, 1).is_err(),
            "\"me\" must fail"
        );
        assert!(
            validate_judge_output(r#"{"labels": {"0": "unknown"}}"#, 1, 1).is_err(),
            "\"unknown\" must fail"
        );
        assert!(
            validate_judge_output(r#"{"labels": {"0": "Others"}}"#, 1, 1).is_err(),
            "non-round-tripping label must fail"
        );
    }

    #[test]
    fn judge_flag_defaults_off_and_enables_only_on_exact_one() {
        // Arrange: snapshot the ambient env so this test never leaks a
        // mutation into sibling tests.
        let saved = std::env::var(DIARIZE_JUDGE_ENV_VAR).ok();

        // Act / Assert: sequential within this single test so no parallel
        // test can race on the same env var.
        std::env::remove_var(DIARIZE_JUDGE_ENV_VAR);
        assert!(!is_judge_enabled(), "unset flag must default to OFF");

        std::env::set_var(DIARIZE_JUDGE_ENV_VAR, "1");
        assert!(is_judge_enabled(), "\"1\" must enable the judge");

        std::env::set_var(DIARIZE_JUDGE_ENV_VAR, "0");
        assert!(!is_judge_enabled(), "\"0\" must leave the judge OFF");

        std::env::set_var(DIARIZE_JUDGE_ENV_VAR, "true");
        assert!(!is_judge_enabled(), "only exact \"1\" enables the judge");

        // Cleanup: restore the ambient value.
        match saved {
            Some(value) => std::env::set_var(DIARIZE_JUDGE_ENV_VAR, value),
            None => std::env::remove_var(DIARIZE_JUDGE_ENV_VAR),
        }
    }

    #[test]
    fn apply_judge_labels_swaps_only_speakers_and_respects_pinned() {
        use myna_stt::{Transcript, TranscriptSegment};

        // Arrange: one free segment plus one user-pinned segment.
        let transcript = Transcript {
            segments: vec![
                TranscriptSegment {
                    start_sec: 0.0,
                    end_sec: 1.5,
                    text: "hello team".to_string(),
                    speaker: Speaker::others(),
                    speaker_pinned: false,
                    suspect_reasons: Vec::new(),
                    original_text: None,
                    edited: false,
                },
                TranscriptSegment {
                    start_sec: 1.5,
                    end_sec: 3.0,
                    text: "quarterly results".to_string(),
                    speaker: Speaker::me(),
                    speaker_pinned: true,
                    suspect_reasons: Vec::new(),
                    original_text: None,
                    edited: false,
                },
            ],
        };
        let before_text = transcript.full_text();
        let labels = vec![Speaker::others_id("1"), Speaker::others_id("2")];

        // Act
        let judged = apply_judge_labels(&transcript, &labels);

        // Assert: free segment takes the judge label; pinned keeps its own.
        assert_eq!(judged.segments[0].speaker, Speaker::others_id("1"));
        assert_eq!(judged.segments[1].speaker, Speaker::me());
        // Assert: text and timing are byte-identical.
        assert_eq!(judged.full_text(), before_text);
        assert_eq!(judged.segments[0].start_sec, 0.0);
        assert_eq!(judged.segments[0].end_sec, 1.5);
        assert_eq!(judged.segments[0].text, "hello team");
        assert_eq!(judged.segments[1].start_sec, 1.5);
        assert_eq!(judged.segments[1].end_sec, 3.0);
        assert_eq!(judged.segments[1].text, "quarterly results");
    }
}
