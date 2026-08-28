//! Timestamped transcript types shared by offline decode and streaming.

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// One segment of a transcript, with a start/end time in seconds.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TranscriptSegment {
    pub start_sec: f32,
    pub end_sec: f32,
    pub text: String,
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
}
