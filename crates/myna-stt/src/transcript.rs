//! Timestamped transcript types shared by offline decode and streaming.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Who spoke a transcript segment, stored flat as `"unknown"`, `"me"`,
/// `"others"`, or `"others:<id>"`.
///
/// Serializes to (and deserializes from) a bare JSON string rather than a
/// tagged enum/object. Deserialization always routes through [`Speaker::parse`],
/// so a malformed or forward-incompatible label degrades to
/// [`Speaker::unknown`] instead of failing to parse — this matters because
/// `fs_store::read_meeting_file` silently drops any `meeting.json` that
/// fails to deserialize.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Speaker(String);

impl Default for Speaker {
    fn default() -> Self {
        Self::unknown()
    }
}

impl Speaker {
    /// The speaker is not (yet) known.
    pub fn unknown() -> Self {
        Speaker("unknown".to_string())
    }

    /// The local user / meeting owner.
    pub fn me() -> Self {
        Speaker("me".to_string())
    }

    /// An unidentified other participant.
    pub fn others() -> Self {
        Speaker("others".to_string())
    }

    /// A specific other participant, distinguished by `id`.
    pub fn others_id(id: &str) -> Self {
        Speaker(format!("others:{id}"))
    }

    /// Parses `raw` into a [`Speaker`], validating its shape. Never errors:
    /// anything that isn't a well-formed label (`[a-z]+` optionally
    /// followed by `:` then `[a-z0-9_-]+`) falls back to
    /// [`Speaker::unknown`].
    pub fn parse(raw: &str) -> Self {
        if Self::is_well_formed(raw) {
            Speaker(raw.to_string())
        } else {
            Self::unknown()
        }
    }

    fn is_well_formed(raw: &str) -> bool {
        let (role, sub_id) = match raw.split_once(':') {
            Some((role, sub_id)) => (role, Some(sub_id)),
            None => (raw, None),
        };
        if role.is_empty() || !role.chars().all(|c| c.is_ascii_lowercase()) {
            return false;
        }
        match sub_id {
            Some(sub_id) => {
                !sub_id.is_empty()
                    && sub_id.chars().all(|c| {
                        c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-'
                    })
            }
            None => true,
        }
    }

    /// The broad role encoded by this label's prefix before any `:`.
    pub fn role(&self) -> SpeakerRole {
        let role_str = self
            .0
            .split_once(':')
            .map(|(role, _)| role)
            .unwrap_or(&self.0);
        match role_str {
            "me" => SpeakerRole::Me,
            "others" => SpeakerRole::Others,
            _ => SpeakerRole::Unknown,
        }
    }

    /// The substring after the first `:`, if any.
    pub fn sub_id(&self) -> Option<&str> {
        self.0.split_once(':').map(|(_, sub_id)| sub_id)
    }

    /// The raw, flat label (e.g. `"others:3"`).
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Serialize for Speaker {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Speaker {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Ok(Speaker::parse(&raw))
    }
}

/// The broad role a [`Speaker`] label encodes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpeakerRole {
    Unknown,
    Me,
    Others,
}

/// One segment of a transcript, with a start/end time in seconds.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TranscriptSegment {
    pub start_sec: f32,
    pub end_sec: f32,
    pub text: String,
    #[serde(default)]
    pub speaker: Speaker,
    /// `true` once a human has manually corrected this segment's `speaker`.
    /// Pinned segments must never be silently overwritten by automated
    /// relabeling (see [`crate::relabel::relabel_others`]). This crate never
    /// sets it `true` itself — only a future user-driven command will.
    ///
    /// `#[serde(default)]` is load-bearing: a non-defaulted field would make
    /// every legacy `meeting.json` written before this field existed fail
    /// to deserialize, and `fs_store::read_meeting_file` silently drops any
    /// meeting that fails to parse.
    #[serde(default)]
    pub speaker_pinned: bool,
}

/// An ordered collection of transcript segments.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Transcript {
    pub segments: Vec<TranscriptSegment>,
}

impl Transcript {
    /// Concatenates every segment's text, space-separated.
    pub fn full_text(&self) -> String {
        self.segments
            .iter()
            .map(|segment| segment.text.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Returns the transcript's total duration, measured from zero to the
    /// last segment's end. Zero when there are no segments.
    pub fn duration(&self) -> Duration {
        let end_sec = self
            .segments
            .last()
            .map(|segment| segment.end_sec)
            .unwrap_or(0.0);
        Duration::from_secs_f32(end_sec.max(0.0))
    }

    /// Returns a new `Transcript` with `seg` appended. `self` is left
    /// unchanged.
    pub fn with_segment(&self, seg: TranscriptSegment) -> Transcript {
        let mut segments = self.segments.clone();
        segments.push(seg);
        Transcript { segments }
    }

    /// Renders the transcript grouped by consecutive same-speaker segments,
    /// one line per group, joined by `"\n"`. Within a group, segment texts
    /// are joined with a single space (matching [`Self::full_text`]).
    ///
    /// A group whose speaker's [`SpeakerRole`] is [`SpeakerRole::Unknown`]
    /// is emitted with no prefix. Otherwise the line is prefixed with
    /// `"Me: "`, `"Others: "`, or `"Others <id>: "`.
    pub fn attributed_text(&self) -> String {
        self.attributed_text_with_names(&BTreeMap::new())
    }

    /// Groups and renders exactly like [`Self::attributed_text`], except a
    /// speaker whose flat label (e.g. `"others:1"`) has an entry in `names`
    /// is rendered under that display name (`"Jean: ..."`) instead of its
    /// role-derived prefix (`"Others 1: ..."`).
    ///
    /// Grouping stays keyed by the underlying [`Speaker`] label, never by
    /// the rendered name — two distinct labels that happen to share a
    /// display name (e.g. two participants both named "Sam") must still
    /// produce separate consecutive-run groups rather than merging, so a
    /// display name is looked up only after grouping, purely for rendering.
    pub fn attributed_text_with_names(&self, names: &BTreeMap<String, String>) -> String {
        let mut groups: Vec<(Speaker, Vec<&str>)> = Vec::new();
        for segment in &self.segments {
            match groups.last_mut() {
                Some((speaker, texts)) if *speaker == segment.speaker => {
                    texts.push(segment.text.as_str());
                }
                _ => groups.push((segment.speaker.clone(), vec![segment.text.as_str()])),
            }
        }

        groups
            .into_iter()
            .map(|(speaker, texts)| {
                let joined = texts.join(" ");
                if let Some(name) = names.get(speaker.as_str()) {
                    return format!("{name}: {joined}");
                }
                match speaker.role() {
                    SpeakerRole::Unknown => joined,
                    SpeakerRole::Me => format!("Me: {joined}"),
                    SpeakerRole::Others => match speaker.sub_id() {
                        Some(id) => format!("Others {id}: {joined}"),
                        None => format!("Others: {joined}"),
                    },
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Speaker: default ------------------------------------------------

    #[test]
    fn speaker_default_is_unknown_with_unknown_role() {
        let speaker = Speaker::default();

        assert_eq!(speaker, Speaker::unknown());
        assert_eq!(speaker.role(), SpeakerRole::Unknown);
    }

    // ---- Speaker: serde round-trip as a bare JSON string ------------------

    #[test]
    fn others_id_serializes_to_a_bare_json_string_and_round_trips() {
        let speaker = Speaker::others_id("3");

        let json = serde_json::to_string(&speaker).expect("serialize");
        assert_eq!(json, "\"others:3\"");

        let back: Speaker = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, speaker);
        assert_eq!(back.as_str(), "others:3");
    }

    // ---- Speaker: forward-compat for well-formed but unknown labels -------

    #[test]
    fn a_well_formed_but_unrecognized_label_round_trips_losslessly() {
        let json = "\"others:7\"";

        let speaker: Speaker = serde_json::from_str(json).expect("deserialize");
        assert_eq!(speaker.as_str(), "others:7");

        let round_tripped = serde_json::to_string(&speaker).expect("serialize");
        assert_eq!(round_tripped, json);
    }

    // ---- Speaker: malformed labels never error, they fall back to unknown -

    #[test]
    fn malformed_labels_deserialize_to_unknown_without_erroring() {
        for raw in ["\"Others 3\"", "\"\"", "\"me:@!\""] {
            let speaker: Speaker =
                serde_json::from_str(raw).unwrap_or_else(|_| panic!("must not error on {raw}"));
            assert_eq!(speaker, Speaker::unknown(), "input was {raw}");
        }
    }

    // ---- Speaker: role() / sub_id() ----------------------------------------

    #[test]
    fn role_and_sub_id_reflect_the_stored_label() {
        let me = Speaker::me();
        assert_eq!(me.role(), SpeakerRole::Me);
        assert_eq!(me.sub_id(), None);

        let others = Speaker::others();
        assert_eq!(others.role(), SpeakerRole::Others);
        assert_eq!(others.sub_id(), None);

        let others_2 = Speaker::parse("others:2");
        assert_eq!(others_2.role(), SpeakerRole::Others);
        assert_eq!(others_2.sub_id(), Some("2"));
    }

    // ---- TranscriptSegment: speaker defaults on legacy JSON ---------------

    #[test]
    fn transcript_segment_without_a_speaker_key_deserializes_to_unknown() {
        let json = r#"{"start_sec": 0.0, "end_sec": 1.5, "text": "hello team"}"#;

        let segment: TranscriptSegment = serde_json::from_str(json).expect(
            "a legacy segment JSON object missing `speaker` must still deserialize \
             (fs_store::read_meeting_file silently drops meetings that fail to parse)",
        );

        assert_eq!(segment.speaker, Speaker::unknown());
        assert_eq!(segment.text, "hello team");
    }

    // ---- TranscriptSegment: speaker_pinned defaults on legacy JSON -------

    #[test]
    fn transcript_segment_without_a_speaker_pinned_key_deserializes_to_false() {
        let json =
            r#"{"start_sec": 0.0, "end_sec": 1.5, "text": "hello team", "speaker": "others"}"#;

        let segment: TranscriptSegment = serde_json::from_str(json).expect(
            "a legacy segment JSON object missing `speaker_pinned` must still deserialize \
             (fs_store::read_meeting_file silently drops meetings that fail to parse)",
        );

        assert!(!segment.speaker_pinned);
    }

    // ---- Transcript::attributed_text() -------------------------------------

    #[test]
    fn attributed_text_prefixes_lines_by_speaker_and_merges_consecutive_same_speaker() {
        let transcript = Transcript::default()
            .with_segment(TranscriptSegment {
                start_sec: 0.0,
                end_sec: 1.0,
                text: "hello".to_string(),
                speaker: Speaker::me(),
                speaker_pinned: false,
            })
            .with_segment(TranscriptSegment {
                start_sec: 1.0,
                end_sec: 2.0,
                text: "team".to_string(),
                speaker: Speaker::me(),
                speaker_pinned: false,
            })
            .with_segment(TranscriptSegment {
                start_sec: 2.0,
                end_sec: 3.0,
                text: "hi there".to_string(),
                speaker: Speaker::others(),
                speaker_pinned: false,
            })
            .with_segment(TranscriptSegment {
                start_sec: 3.0,
                end_sec: 4.0,
                text: "how are you".to_string(),
                speaker: Speaker::parse("others:2"),
                speaker_pinned: false,
            });

        let attributed = transcript.attributed_text();

        assert_eq!(
            attributed,
            "Me: hello team\nOthers: hi there\nOthers 2: how are you"
        );
    }

    #[test]
    fn attributed_text_emits_bare_text_when_every_segment_is_unknown() {
        let transcript = Transcript::default()
            .with_segment(TranscriptSegment {
                start_sec: 0.0,
                end_sec: 1.0,
                text: "hello".to_string(),
                speaker: Speaker::unknown(),
                speaker_pinned: false,
            })
            .with_segment(TranscriptSegment {
                start_sec: 1.0,
                end_sec: 2.0,
                text: "team".to_string(),
                speaker: Speaker::unknown(),
                speaker_pinned: false,
            });

        let attributed = transcript.attributed_text();

        assert_eq!(attributed, "hello team");
    }
}
