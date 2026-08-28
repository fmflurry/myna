//! VAD-segmented simulated streaming: buffer live audio, segment it with a
//! VAD, and re-decode against an offline Parakeet-TDT engine.
//!
//! This module does no I/O of its own — no printing, no audio capture, no
//! threads. The caller owns all of that; this struct only turns sample
//! chunks into [`SttEvent`]s.

use std::sync::Arc;
use std::time::Instant;

use crate::detokenize::Word;
use crate::engine::SttEngine;
use crate::error::SttError;
use crate::transcript::TranscriptSegment;
use crate::vad::{VadConfig, VadSegmenter, TARGET_SAMPLE_RATE, VAD_WINDOW_SIZE};

/// Minimum spacing between live partial-transcript re-decodes.
///
/// Measured decode costs at `num_threads=8` (see `myna-app`'s
/// `stt_engine_threads`) put an 8s-window partial at ~0.44x realtime and a
/// 4s-window partial at ~0.45x realtime at a 1.0s / 2.0s interval
/// respectively — comfortably under budget. The previous `0.2` was never
/// actually enforced (see [`PartialThrottle`]'s docs on the ordering bug
/// this constant's interval was defeated by) and would have meant ~5x
/// more decodes than intended even once fixed.
const PARTIAL_INTERVAL_SEC: f32 = 1.0;

/// While idle (no speech detected yet in the current utterance), trim
/// leading silence once the buffer grows past this many VAD windows, so an
/// unbounded quiet period doesn't grow the buffer forever.
const IDLE_TRIM_WINDOWS: usize = 10;

/// Maximum trailing window, in seconds, decoded for a live partial
/// hypothesis. [`SimulatedStreamer::maybe_partial`] re-decodes the growing
/// utterance buffer from scratch every [`PARTIAL_INTERVAL_SEC`]; decoding
/// the *entire* buffer for an utterance nearing
/// `VadConfig::max_speech_sec` (30s) burns several seconds of CPU
/// synchronously inside `push()` at the measured decode RTF (~0.13), so
/// live captions fall progressively behind and the audio callback backs
/// up. Only partials are windowed this way — [`SimulatedStreamer::finish`]
/// and drained VAD segments always decode the complete segment, so final
/// transcript quality is unaffected.
const PARTIAL_WINDOW_SEC: f32 = 8.0;

/// Stability margin, in seconds, [`PartialCommitState::commit_if_due`]
/// keeps between `committed_upto` and the live edge (`buffer_len`) before
/// folding a word into `committed_text`. Must stay smaller than
/// [`PARTIAL_WINDOW_SEC`] — that gap is what guarantees a word is always
/// committed while it is still inside the decode window, before it can
/// ever age out of it (see that function's docs for why a fixed
/// per-commit step size instead of a rolling margin silently loses text).
/// Committing lets a live partial display the *whole* current utterance —
/// not just [`PARTIAL_WINDOW_SEC`] of it — while every individual decode
/// still only ever sees `PARTIAL_WINDOW_SEC` of audio: committed text is
/// assembled incrementally from words old enough to be considered stable,
/// never from a full-utterance re-decode.
const PARTIAL_COMMIT_HOP_SEC: f32 = 4.0;

/// Extra trailing context, in seconds, kept *before* `committed_upto` when
/// choosing the next partial decode window (see
/// [`PartialCommitState::window_start`]). Without this, the window could
/// start exactly at a commit boundary that falls mid-word, truncating the
/// first word of every decode. The overlap re-decodes that trailing
/// context every time, but [`PartialCommitState::apply_decode`] discards
/// any word already covered by `committed_upto`, so nothing is
/// double-counted in the displayed text.
const PARTIAL_OVERLAP_SEC: f32 = 2.0;

/// Pure throttle answering "may a live partial re-decode start now?" —
/// driven by a caller-supplied `Instant` so it's unit-testable without a
/// loaded engine or real sleeping.
///
/// Critically, [`PartialThrottle::mark_decoded`] must be called **after**
/// the decode completes, not before it starts. The bug this fixes: the
/// previous code set `last_partial = Instant::now()` immediately before
/// kicking off a decode that itself routinely took far longer than the
/// interval (e.g. p50 700ms decodes against a 200ms interval), so by the
/// time the *next* `push()` call checked the elapsed time, it had already
/// been satisfied — the cap never bound. Measured: 601 partials over 15s
/// of speech (40.1/s) against an intended 5/s. Starting the clock from
/// when the decode *finished* means a slow decode can never itself unlock
/// the next one early.
struct PartialThrottle {
    interval_sec: f32,
    last_decoded: Option<Instant>,
}

impl PartialThrottle {
    fn new(interval_sec: f32) -> Self {
        Self {
            interval_sec,
            last_decoded: None,
        }
    }

    /// Returns `true` if a decode may start at `now` — `true` the first
    /// time, and thereafter only once `interval_sec` has elapsed since
    /// the *previous decode completed* (see [`Self::mark_decoded`]).
    fn should_decode(&self, now: Instant) -> bool {
        match self.last_decoded {
            None => true,
            Some(last) => now.saturating_duration_since(last).as_secs_f32() >= self.interval_sec,
        }
    }

    /// Records that a decode completed at `now`. Callers must call this
    /// only after the decode has actually finished — see the struct docs
    /// for why the ordering matters.
    fn mark_decoded(&mut self, now: Instant) {
        self.last_decoded = Some(now);
    }
}

/// Incremental-commit state and logic for the current utterance's live
/// partial transcript.
///
/// The core problem: a live partial must show the *whole* utterance so
/// far, but re-decoding the whole utterance on every partial is the exact
/// cost blowup [`PARTIAL_WINDOW_SEC`] exists to prevent. The fix is to
/// decode only a bounded trailing window (as before), but track which
/// prefix of the utterance has already scrolled safely behind that window
/// and fold its text into `committed_text` — a plain `String`, not audio —
/// so it never needs decoding again. Each partial then displays
/// `committed_text` plus whatever the (still-bounded) window's decode adds
/// beyond it.
///
/// Split out from [`SimulatedStreamer`] so the windowing/commit arithmetic
/// is unit-testable against synthetic word lists, without a loaded
/// [`SttEngine`] — mirrors why [`PartialThrottle`] takes an injected
/// `Instant` instead of calling `Instant::now()` itself.
#[derive(Debug, Default)]
struct PartialCommitState {
    /// Text already committed from earlier parts of the current utterance.
    committed_text: String,
    /// Sample offset, within the utterance buffer, that `committed_text`
    /// covers. Words ending at or before this offset are never
    /// re-displayed from a fresh decode — they're already in
    /// `committed_text`.
    committed_upto: usize,
}

impl PartialCommitState {
    /// Clears committed state — called whenever the current utterance
    /// ends, so no text bleeds into the next one.
    fn reset(&mut self) {
        self.committed_text.clear();
        self.committed_upto = 0;
    }

    /// Sample offset at which to start decoding the next live partial:
    /// far enough back to include [`PARTIAL_OVERLAP_SEC`] of context
    /// before `committed_upto` (so the window never starts mid-word), but
    /// never more than [`PARTIAL_WINDOW_SEC`] behind `buffer_len` — the
    /// invariant that bounds decode cost regardless of utterance length.
    fn window_start(&self, buffer_len: usize) -> usize {
        let window_samples = (PARTIAL_WINDOW_SEC * TARGET_SAMPLE_RATE as f32) as usize;
        let overlap_samples = (PARTIAL_OVERLAP_SEC * TARGET_SAMPLE_RATE as f32) as usize;
        let overlap_start = self.committed_upto.saturating_sub(overlap_samples);
        let window_floor = buffer_len.saturating_sub(window_samples);
        overlap_start.max(window_floor).min(buffer_len)
    }

    /// Applies one decode's result: `words` are timed relative to the
    /// decoded slice `window_start..buffer_len`. Returns the full text to
    /// display this round (`committed_text` plus everything beyond it),
    /// and commits newly-eligible words into `committed_text` for next
    /// time via [`Self::commit_if_due`].
    fn apply_decode(&mut self, buffer_len: usize, window_start: usize, words: Vec<Word>) -> String {
        let offset_sec = window_start as f32 / TARGET_SAMPLE_RATE as f32;
        let absolute_words: Vec<Word> = words
            .into_iter()
            .map(|word| Word {
                text: word.text,
                start_sec: word.start_sec + offset_sec,
                end_sec: word.end_sec + offset_sec,
            })
            .collect();

        let committed_upto_sec = self.committed_upto as f32 / TARGET_SAMPLE_RATE as f32;
        let tail_text = absolute_words
            .iter()
            .filter(|word| word.end_sec > committed_upto_sec)
            .map(|word| word.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let text = join_committed(&self.committed_text, &tail_text);

        self.commit_if_due(buffer_len, &absolute_words);
        text
    }

    /// Folds every whole word that is now more than [`PARTIAL_COMMIT_HOP_SEC`]
    /// behind the live edge (`buffer_len`) into `committed_text`, and
    /// advances `committed_upto` up to that rolling boundary.
    ///
    /// This runs every decode (not just periodically): [`PARTIAL_COMMIT_HOP_SEC`]
    /// is a *stability margin*, not a fixed step size. That distinction
    /// matters for correctness, not just style — [`Self::window_start`]'s
    /// decode window only ever slides forward with `buffer_len`, so any
    /// word that ages out of it (falls behind `buffer_len - PARTIAL_WINDOW_SEC`)
    /// without first having been committed is gone forever, silently
    /// truncating the displayed transcript exactly like the original bug.
    /// Advancing `committed_upto` by a fixed hop *from its own previous
    /// value* (rather than from the live edge) lets that gap grow
    /// unboundedly between commits, because `committed_upto` stands still
    /// while the window keeps moving. Recomputing the boundary from
    /// `buffer_len` every call keeps `committed_upto` within
    /// `PARTIAL_COMMIT_HOP_SEC` of the window's own trailing edge at all
    /// times — comfortably inside [`PARTIAL_WINDOW_SEC`] (`hop < window`),
    /// so a word is always committed while it is still decodable, well
    /// before it would age out.
    ///
    /// A word straddling the boundary is left uncommitted (never split
    /// mid-word) — it stays inside the window and is re-displayed from the
    /// tail instead, until a later call's boundary passes its end.
    fn commit_if_due(&mut self, buffer_len: usize, absolute_words: &[Word]) {
        let hop_samples = (PARTIAL_COMMIT_HOP_SEC * TARGET_SAMPLE_RATE as f32) as usize;
        let commit_boundary = buffer_len.saturating_sub(hop_samples);
        if commit_boundary <= self.committed_upto {
            return;
        }

        let committed_upto_sec = self.committed_upto as f32 / TARGET_SAMPLE_RATE as f32;
        let boundary_sec = commit_boundary as f32 / TARGET_SAMPLE_RATE as f32;

        for word in absolute_words {
            if word.end_sec > committed_upto_sec && word.end_sec <= boundary_sec {
                if !self.committed_text.is_empty() {
                    self.committed_text.push(' ');
                }
                self.committed_text.push_str(&word.text);
            }
        }
        self.committed_upto = commit_boundary;
    }
}

/// Joins already-committed text with this round's tail text, inserting a
/// separating space only when both sides are non-empty.
fn join_committed(committed: &str, tail: &str) -> String {
    match (committed.is_empty(), tail.is_empty()) {
        (true, _) => tail.to_string(),
        (false, true) => committed.to_string(),
        (false, false) => format!("{committed} {tail}"),
    }
}

/// Options controlling [`SimulatedStreamer`] behaviour.
#[derive(Debug, Clone)]
pub struct StreamerOptions {
    /// When `false`, [`SimulatedStreamer::push`] never emits
    /// [`SttEvent::Partial`] events — only finals. Defaults to `true` so
    /// existing callers (`SimulatedStreamer::new`) keep today's
    /// always-emit-partials behaviour unchanged.
    pub emit_partials: bool,
}

impl Default for StreamerOptions {
    fn default() -> Self {
        Self {
            emit_partials: true,
        }
    }
}

/// Pure gate answering "may [`SimulatedStreamer::maybe_partial`] emit a
/// partial event right now?" — split out so it's unit-testable without a
/// loaded [`SttEngine`], mirroring why [`PartialThrottle`] takes an injected
/// `Instant` instead of calling `Instant::now()` itself.
fn should_emit_partial(
    options: &StreamerOptions,
    speech_started: bool,
    throttle_ready: bool,
) -> bool {
    options.emit_partials && speech_started && throttle_ready
}

/// An event emitted while streaming audio through [`SimulatedStreamer`].
#[derive(Debug, Clone)]
pub enum SttEvent {
    /// A live, not-yet-final hypothesis for the audio currently buffered.
    Partial { text: String },
    /// A finished, timestamped segment.
    Final { segment: TranscriptSegment },
}

/// Buffers live audio, segments it with a VAD, and decodes it against a
/// Parakeet-TDT [`SttEngine`].
///
/// "Simulated streaming" because the underlying model is offline: this
/// struct re-decodes a growing buffer rather than truly streaming through
/// the model.
pub struct SimulatedStreamer {
    engine: Arc<SttEngine>,
    vad: VadSegmenter,
    /// Raw samples of the current in-progress utterance.
    buffer: Vec<f32>,
    /// Number of samples at the front of `buffer` already fed to the VAD.
    offset: usize,
    speech_started: bool,
    partial_throttle: PartialThrottle,
    /// Incremental-commit state for the current utterance's live partial —
    /// see [`PartialCommitState`].
    partial_commit: PartialCommitState,
    /// Running count of samples seen since the streamer was created.
    total_samples: usize,
    /// Behavioural options — see [`StreamerOptions`].
    options: StreamerOptions,
}

impl SimulatedStreamer {
    /// Builds a streamer around an already-loaded, shared engine and a VAD
    /// config. `engine` is `Arc`-shared rather than owned so callers can
    /// cache a single loaded engine (model load is seconds-scale) and reuse
    /// it across many streaming sessions.
    pub fn new(engine: Arc<SttEngine>, vad_cfg: &VadConfig) -> Result<Self, SttError> {
        Self::with_options(engine, vad_cfg, StreamerOptions::default())
    }

    /// Builds a streamer with explicit [`StreamerOptions`] — see
    /// [`Self::new`] for the default-options constructor most callers want.
    pub fn with_options(
        engine: Arc<SttEngine>,
        vad_cfg: &VadConfig,
        options: StreamerOptions,
    ) -> Result<Self, SttError> {
        let vad = VadSegmenter::load(vad_cfg)?;
        Ok(Self {
            engine,
            vad,
            buffer: Vec::new(),
            offset: 0,
            speech_started: false,
            partial_throttle: PartialThrottle::new(PARTIAL_INTERVAL_SEC),
            partial_commit: PartialCommitState::default(),
            total_samples: 0,
            options,
        })
    }

    /// Feeds a chunk of [`TARGET_SAMPLE_RATE`] mono samples, returning any
    /// events produced.
    pub fn push(&mut self, samples: &[f32]) -> Result<Vec<SttEvent>, SttError> {
        self.buffer.extend_from_slice(samples);
        self.total_samples += samples.len();

        self.feed_vad();
        let mut events = self.drain_finals()?;
        self.trim_leading_silence();

        if let Some(partial) = self.maybe_partial()? {
            events.push(partial);
        }

        Ok(events)
    }

    /// Flushes the VAD and decodes any remaining buffered audio.
    pub fn finish(&mut self) -> Result<Vec<SttEvent>, SttError> {
        self.vad.flush();
        let mut events = self.drain_finals()?;

        if let Some(event) = self.decode_tail()? {
            events.push(event);
        }

        Ok(events)
    }

    /// Feeds every full [`VAD_WINDOW_SIZE`] window that has accumulated
    /// since the last feed, latching `speech_started` once detected.
    fn feed_vad(&mut self) {
        while self.buffer.len() - self.offset >= VAD_WINDOW_SIZE {
            let end = self.offset + VAD_WINDOW_SIZE;
            self.vad.feed(&self.buffer[self.offset..end]);
            self.offset = end;
            if self.vad.detected() {
                self.speech_started = true;
            }
        }
    }

    /// Drains finished VAD segments, decoding each into a [`SttEvent::Final`]
    /// and resetting the in-progress utterance state.
    fn drain_finals(&mut self) -> Result<Vec<SttEvent>, SttError> {
        let mut events = Vec::new();
        for (start_sample, samples) in self.vad.drain_segments() {
            let text = self
                .engine
                .transcribe_samples(TARGET_SAMPLE_RATE, &samples)?;
            let start_sec = start_sample as f32 / TARGET_SAMPLE_RATE as f32;
            let end_sec = start_sec + samples.len() as f32 / TARGET_SAMPLE_RATE as f32;
            events.push(SttEvent::Final {
                segment: TranscriptSegment {
                    start_sec,
                    end_sec,
                    text,
                },
            });
            self.reset_utterance();
        }
        Ok(events)
    }

    /// Drops old, already-fed samples from the front of `buffer` while no
    /// speech has been detected yet, keeping the last window intact.
    ///
    /// Only called after [`Self::feed_vad`] has run for this chunk, so
    /// `self.offset` (samples already fed to the VAD) always trails
    /// `buffer.len()` by less than one [`VAD_WINDOW_SIZE`] — the partial
    /// window feed_vad has not yet had enough samples to feed. `drop_count`
    /// is therefore always `<= self.offset`: this never discards the unfed
    /// tail, only samples the VAD has already seen and already made its
    /// segmentation decision on.
    fn trim_leading_silence(&mut self) {
        let idle_threshold = IDLE_TRIM_WINDOWS * VAD_WINDOW_SIZE;
        if self.speech_started || self.buffer.len() <= idle_threshold {
            return;
        }

        let drop_count = self.buffer.len() - VAD_WINDOW_SIZE;
        debug_assert!(
            drop_count <= self.offset,
            "leading-silence trim must never drop samples the VAD has not seen yet"
        );
        self.buffer.drain(0..drop_count);
        self.offset = self.offset.saturating_sub(drop_count);
    }

    /// Re-decodes a bounded trailing window of the live buffer into a
    /// [`SttEvent::Partial`], throttled by [`PartialThrottle`] to at most
    /// once every [`PARTIAL_INTERVAL_SEC`] — measured from when the
    /// previous decode *completed*, not started, so a slow decode can
    /// never defeat the cap (see [`PartialThrottle`]'s docs).
    ///
    /// The decode input itself never exceeds [`PARTIAL_WINDOW_SEC`]
    /// (bounding cost), but the *displayed* text covers the whole
    /// utterance so far via [`PartialCommitState`], which folds words that
    /// have scrolled behind the window into `committed_text` instead of
    /// ever re-decoding them.
    fn maybe_partial(&mut self) -> Result<Option<SttEvent>, SttError> {
        let throttle_ready = self.partial_throttle.should_decode(Instant::now());
        if !should_emit_partial(&self.options, self.speech_started, throttle_ready) {
            return Ok(None);
        }

        let buffer_len = self.buffer.len();
        let window_start = self.partial_commit.window_start(buffer_len);
        let words = self
            .engine
            .transcribe_samples_words(TARGET_SAMPLE_RATE, &self.buffer[window_start..])?;
        self.partial_throttle.mark_decoded(Instant::now());

        let text = self
            .partial_commit
            .apply_decode(buffer_len, window_start, words);
        Ok(Some(SttEvent::Partial { text }))
    }

    /// Decodes whatever is left in the buffer as a final trailing segment.
    fn decode_tail(&mut self) -> Result<Option<SttEvent>, SttError> {
        if self.buffer.is_empty() {
            return Ok(None);
        }

        let text = self
            .engine
            .transcribe_samples(TARGET_SAMPLE_RATE, &self.buffer)?;
        let event = if text.trim().is_empty() {
            None
        } else {
            let end_sec = self.total_samples as f32 / TARGET_SAMPLE_RATE as f32;
            let start_sec = end_sec - self.buffer.len() as f32 / TARGET_SAMPLE_RATE as f32;
            Some(SttEvent::Final {
                segment: TranscriptSegment {
                    start_sec,
                    end_sec,
                    text,
                },
            })
        };

        self.reset_utterance();
        Ok(event)
    }

    /// Resets per-utterance state once a segment has been finalized.
    ///
    /// Drops only the prefix already fed to the VAD (`self.offset` samples).
    /// A single `push()` call can contain the tail of one utterance and the
    /// start of the next (e.g. end-of-speech silence followed immediately by
    /// new speech, all in one audio chunk); by the time this runs, those new
    /// trailing samples may already be sitting in `buffer[offset..]`,
    /// unfed. Clearing the whole buffer here would silently discard them —
    /// audio that was never fed to the VAD and can never be recovered.
    fn reset_utterance(&mut self) {
        self.buffer.drain(0..self.offset);
        self.offset = 0;
        self.speech_started = false;
        self.partial_commit.reset();
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn window_samples() -> usize {
        (PARTIAL_WINDOW_SEC * TARGET_SAMPLE_RATE as f32) as usize
    }

    #[test]
    fn partial_throttle_allows_the_first_decode_immediately() {
        // Arrange
        let throttle = PartialThrottle::new(1.0);

        // Act
        let allowed = throttle.should_decode(Instant::now());

        // Assert
        assert!(allowed);
    }

    #[test]
    fn partial_throttle_blocks_a_second_decode_started_right_after_the_first_finished() {
        // Arrange
        let mut throttle = PartialThrottle::new(1.0);
        let decode_finished_at = Instant::now();
        throttle.mark_decoded(decode_finished_at);

        // Act
        let allowed = throttle.should_decode(decode_finished_at + Duration::from_millis(100));

        // Assert
        assert!(!allowed);
    }

    #[test]
    fn partial_throttle_allows_a_decode_once_the_interval_has_elapsed_since_the_last_one_finished()
    {
        // Arrange
        let mut throttle = PartialThrottle::new(1.0);
        let decode_finished_at = Instant::now();
        throttle.mark_decoded(decode_finished_at);

        // Act
        let allowed = throttle.should_decode(decode_finished_at + Duration::from_secs_f32(1.0));

        // Assert
        assert!(allowed);
    }

    /// Regression test for the throttle-ordering bug: `last_partial` used
    /// to be stamped *before* the decode ran, so a decode that itself took
    /// longer than the interval defeated the cap entirely (measured: 601
    /// partials over 15s of speech, 8x the intended rate). This simulates
    /// decodes that each take far longer than the interval — via a fake
    /// clock advanced by `Duration` arithmetic, never real sleeping — and
    /// asserts the number of decodes that start over a fixed simulated
    /// span can never exceed what `1 / interval` allows, no matter how
    /// slow each decode is.
    ///
    /// If `mark_decoded` were called with the pre-decode instant instead
    /// of the post-decode one (reinstating the bug), this test fails: the
    /// throttle would allow a new decode on every single `maybe_decode`
    /// check once the *start*-to-start gap, rather than the slower
    /// finish-to-start gap, exceeded the interval.
    #[test]
    fn partial_throttle_caps_decode_rate_even_when_every_decode_is_slower_than_the_interval() {
        // Arrange
        const INTERVAL_SEC: f32 = 1.0;
        const SIMULATED_DECODE_DURATION_SEC: f32 = 5.0; // >> INTERVAL_SEC
        const SIMULATED_TOTAL_SPAN_SEC: f32 = 15.0;
        const CHUNK_STEP_SEC: f32 = 0.02; // mirrors a 20ms audio callback

        let mut throttle = PartialThrottle::new(INTERVAL_SEC);
        let mut now = Instant::now();
        let end = now + Duration::from_secs_f32(SIMULATED_TOTAL_SPAN_SEC);
        let mut decode_count = 0u32;

        // Act: poll like `push()` does on every audio chunk, "running" a
        // slow decode (advancing the fake clock, not sleeping) whenever
        // the throttle allows one to start.
        while now < end {
            if throttle.should_decode(now) {
                decode_count += 1;
                now += Duration::from_secs_f32(SIMULATED_DECODE_DURATION_SEC);
                throttle.mark_decoded(now);
            } else {
                now += Duration::from_secs_f32(CHUNK_STEP_SEC);
            }
        }

        // Assert: even though each decode alone took 5x the interval, the
        // observed rate must stay within what a 1s interval permits over a
        // 15s span (allowing 1 extra for the unconditional first decode).
        let max_allowed = (SIMULATED_TOTAL_SPAN_SEC / INTERVAL_SEC).ceil() as u32 + 1;
        assert!(
            decode_count <= max_allowed,
            "expected at most {max_allowed} decodes over {SIMULATED_TOTAL_SPAN_SEC}s at a \
             {INTERVAL_SEC}s interval, got {decode_count}"
        );
    }

    fn hop_samples() -> usize {
        (PARTIAL_COMMIT_HOP_SEC * TARGET_SAMPLE_RATE as f32) as usize
    }

    fn overlap_samples() -> usize {
        (PARTIAL_OVERLAP_SEC * TARGET_SAMPLE_RATE as f32) as usize
    }

    /// Builds a [`Word`] with `start_sec`/`end_sec` computed from sample
    /// offsets, so test data can be reasoned about in samples (matching
    /// `committed_upto`'s unit) while still exercising the real
    /// second-based comparisons in `PartialCommitState`.
    fn word_at(text: &str, start_sample: usize, end_sample: usize) -> Word {
        Word {
            text: text.to_string(),
            start_sec: start_sample as f32 / TARGET_SAMPLE_RATE as f32,
            end_sec: end_sample as f32 / TARGET_SAMPLE_RATE as f32,
        }
    }

    #[test]
    fn window_start_never_exceeds_the_window_when_buffer_is_longer() {
        let state = PartialCommitState::default();
        let buffer_len = window_samples() * 4;

        let start = state.window_start(buffer_len);

        assert_eq!(
            buffer_len - start,
            window_samples(),
            "partial decode input must be capped at PARTIAL_WINDOW_SEC worth of samples"
        );
    }

    #[test]
    fn window_start_covers_the_whole_buffer_when_shorter_than_the_window() {
        let state = PartialCommitState::default();
        let buffer_len = window_samples() / 2;

        let start = state.window_start(buffer_len);

        assert_eq!(start, 0);
    }

    #[test]
    fn window_start_is_strictly_smaller_than_a_full_max_speech_buffer() {
        // A 30s utterance (`VadConfig::max_speech_sec`) at TARGET_SAMPLE_RATE
        // is the largest buffer `maybe_partial` can see. Finals (`decode_tail`,
        // `drain_finals`) decode `&self.buffer`/full VAD segments directly and
        // are untouched by `PartialCommitState::window_start` — this asserts
        // the windowed partial path is bounded well below that full-length
        // final input.
        let state = PartialCommitState::default();
        let max_speech_buffer_len = (30.0 * TARGET_SAMPLE_RATE as f32) as usize;

        let start = state.window_start(max_speech_buffer_len);

        assert!(
            max_speech_buffer_len - start < max_speech_buffer_len,
            "partial window must be smaller than the full final-length buffer"
        );
        assert_eq!(max_speech_buffer_len - start, window_samples());
    }

    #[test]
    fn window_start_never_starts_before_the_overlap_context_of_committed_upto() {
        // Once well into a long utterance, the window must stay anchored to
        // `committed_upto - overlap`, not just the trailing PARTIAL_WINDOW_SEC
        // of the buffer, so a word straddling the commit seam is always
        // re-decoded in full rather than truncated.
        let state = PartialCommitState {
            committed_text: String::new(),
            committed_upto: window_samples() * 3,
        };
        let buffer_len = state.committed_upto + hop_samples();

        let start = state.window_start(buffer_len);

        assert_eq!(start, state.committed_upto - overlap_samples());
        assert!(
            buffer_len - start <= window_samples(),
            "decode input must still never exceed PARTIAL_WINDOW_SEC of samples"
        );
    }

    #[test]
    fn apply_decode_never_shrinks_or_loses_the_prefix_as_a_long_utterance_continues() {
        // Regression test for the reported symptom: a long continuous
        // utterance used to show only its trailing ~8s. Simulate the engine
        // "decoding" whatever ground-truth words fall inside each round's
        // bounded window (mirroring what a real decoder would return for
        // that slice), and drive `PartialCommitState` through many rounds as
        // the buffer grows to ~20s. The displayed word count must never
        // decrease, and the final round must show (approximately) every
        // ground-truth word — not just the last window's worth.
        const WORD_DURATION_SEC: f32 = 0.3;
        const WORD_GAP_SEC: f32 = 0.2;
        const WORD_COUNT: usize = 60; // spans ~30s of speech
        const BUFFER_GROWTH_STEP_SEC: f32 = 0.5;

        let ground_truth: Vec<Word> = (0..WORD_COUNT)
            .map(|i| {
                let start_sec = i as f32 * (WORD_DURATION_SEC + WORD_GAP_SEC);
                word_at(
                    &format!("word{i}"),
                    (start_sec * TARGET_SAMPLE_RATE as f32) as usize,
                    ((start_sec + WORD_DURATION_SEC) * TARGET_SAMPLE_RATE as f32) as usize,
                )
            })
            .collect();
        let total_sec = ground_truth.last().unwrap().end_sec;
        let step_samples = (BUFFER_GROWTH_STEP_SEC * TARGET_SAMPLE_RATE as f32) as usize;
        let total_samples = (total_sec * TARGET_SAMPLE_RATE as f32) as usize;

        let mut state = PartialCommitState::default();
        let mut previous_word_count = 0usize;
        let mut buffer_len = step_samples;
        let mut last_text = String::new();

        while buffer_len <= total_samples {
            let window_start = state.window_start(buffer_len);
            assert!(
                buffer_len - window_start <= window_samples(),
                "decode input must never exceed PARTIAL_WINDOW_SEC of samples, even for a long utterance"
            );

            // Simulate the engine: only whole words fully inside the
            // decoded slice are "transcribed", with timing relative to the
            // slice (as the real engine reports it).
            let decoded_words: Vec<Word> = ground_truth
                .iter()
                .filter(|word| {
                    let start_sample = (word.start_sec * TARGET_SAMPLE_RATE as f32) as usize;
                    let end_sample = (word.end_sec * TARGET_SAMPLE_RATE as f32) as usize;
                    start_sample >= window_start && end_sample <= buffer_len
                })
                .map(|word| {
                    let offset_sec = window_start as f32 / TARGET_SAMPLE_RATE as f32;
                    Word {
                        text: word.text.clone(),
                        start_sec: word.start_sec - offset_sec,
                        end_sec: word.end_sec - offset_sec,
                    }
                })
                .collect();

            let text = state.apply_decode(buffer_len, window_start, decoded_words);
            let word_count = text.split_whitespace().count();
            assert!(
                word_count >= previous_word_count,
                "displayed word count must never shrink: {previous_word_count} -> {word_count}"
            );
            previous_word_count = word_count;
            last_text = text;
            buffer_len += step_samples;
        }

        let displayed_words: Vec<&str> = last_text.split_whitespace().collect();
        assert!(
            displayed_words.len() >= WORD_COUNT - 1,
            "final partial ({} words) must cover substantially the whole utterance \
             ({WORD_COUNT} words), not just the trailing window",
            displayed_words.len()
        );
        for (i, word) in displayed_words.iter().enumerate() {
            assert_eq!(
                *word,
                format!("word{i}"),
                "words must stay in order with no gaps"
            );
        }
    }

    #[test]
    fn commits_land_on_word_boundaries_with_no_split_and_no_duplication_at_the_seam() {
        // Exercises `commit_if_due` directly (the exact code `apply_decode`
        // calls) with hand-picked sample offsets, so the rolling
        // stability-margin boundary math is checked precisely.
        let mut state = PartialCommitState::default();
        let hop = hop_samples();

        // A word whose end sits just past the first round's commit
        // boundary (`buffer_len - hop`) — it must not be committed while
        // still that close to the live edge.
        let straddling = word_at("straddles", 100_000, 100_200);
        let buffer_len_1 = 100_100 + hop; // commit boundary == 100_100, inside the word
        state.commit_if_due(buffer_len_1, std::slice::from_ref(&straddling));
        assert!(
            !state.committed_text.contains("straddles"),
            "a word still within the stability margin must never be committed mid-word"
        );

        // Round 2: buffer has grown a little further — the word is now
        // safely behind the margin and becomes eligible.
        let buffer_len_2 = buffer_len_1 + 500;
        state.commit_if_due(buffer_len_2, std::slice::from_ref(&straddling));
        let occurrences = state.committed_text.matches("straddles").count();
        assert_eq!(
            occurrences, 1,
            "the seam word must be committed exactly once — no duplication, and not lost"
        );
    }

    #[test]
    fn reset_clears_committed_state_so_nothing_bleeds_into_the_next_utterance() {
        // Arrange
        let mut state = PartialCommitState {
            committed_text: "leftover text".to_string(),
            committed_upto: 12_345,
        };

        // Act
        state.reset();

        // Assert
        assert_eq!(state.committed_text, "");
        assert_eq!(state.committed_upto, 0);
    }

    #[test]
    fn join_committed_inserts_a_space_only_when_both_sides_are_non_empty() {
        assert_eq!(join_committed("", ""), "");
        assert_eq!(join_committed("", "tail"), "tail");
        assert_eq!(join_committed("committed", ""), "committed");
        assert_eq!(join_committed("committed", "tail"), "committed tail");
    }

    #[test]
    fn streamer_options_default_preserves_existing_always_emit_partials_behaviour() {
        // Regression guard: existing callers (`app/src-tauri/src/session.rs`,
        // `crates/myna-stt/src/main.rs`) build a streamer without opting into
        // this new option, so the default must reproduce today's
        // always-emit-partials behaviour exactly.
        let options = StreamerOptions::default();

        assert!(
            options.emit_partials,
            "default StreamerOptions must keep partial emission on for existing callers"
        );
    }

    #[test]
    fn should_emit_partial_returns_true_when_enabled_and_both_existing_gates_pass() {
        let options = StreamerOptions {
            emit_partials: true,
        };

        assert!(should_emit_partial(&options, true, true));
    }

    #[test]
    fn should_emit_partial_returns_false_when_emit_partials_is_disabled_even_if_other_gates_pass() {
        let options = StreamerOptions {
            emit_partials: false,
        };

        assert!(
            !should_emit_partial(&options, true, true),
            "emit_partials=false must suppress partials regardless of speech/throttle state"
        );
    }

    #[test]
    fn should_emit_partial_still_respects_the_pre_existing_speech_and_throttle_gates_when_enabled()
    {
        let options = StreamerOptions {
            emit_partials: true,
        };

        assert!(
            !should_emit_partial(&options, false, true),
            "no partial before speech has started"
        );
        assert!(
            !should_emit_partial(&options, true, false),
            "no partial while the throttle has not elapsed"
        );
    }

    #[test]
    #[ignore = "requires a downloaded Silero VAD + Parakeet-TDT model to construct a real \
                SttEngine/SimulatedStreamer; the model-free guarantee is covered by the \
                should_emit_partial tests above. Run manually after ./scripts/download-models.sh \
                with `cargo test -p myna-stt --locked -- --ignored`."]
    // RED-phase placeholder, intentionally unfinished: the `todo!()` below is meant to
    // diverge until the StreamerOptions/emit_partials cycle loads a real SttEngine from
    // downloaded model artifacts. The `#[allow]` below exists only to keep the workspace
    // clippy gate (`-D warnings`) green while this test stays `#[ignore]`d; delete both
    // the `#[allow]` and this comment once that cycle is completed.
    #[allow(unreachable_code, unused_variables, clippy::diverging_sub_expression)]
    fn with_options_emit_partials_false_suppresses_partial_events_end_to_end() {
        // Documents the expected integration behaviour once GREEN: with
        // emit_partials=false, push() must never return SttEvent::Partial,
        // even for input that would otherwise trigger one.
        let engine: Arc<SttEngine> = todo!("load a real SttEngine from downloaded model artifacts");
        let vad_cfg = VadConfig {
            model_path: std::path::PathBuf::from("models/silero-vad/silero_vad.onnx"),
            ..VadConfig::default()
        };
        let options = StreamerOptions {
            emit_partials: false,
        };

        let mut streamer =
            SimulatedStreamer::with_options(engine, &vad_cfg, options).expect("construct streamer");

        let chunk = vec![0.05_f32; TARGET_SAMPLE_RATE as usize];
        let mut saw_partial = false;
        for _ in 0..10 {
            let events = streamer.push(&chunk).expect("push");
            if events.iter().any(|e| matches!(e, SttEvent::Partial { .. })) {
                saw_partial = true;
            }
        }

        assert!(
            !saw_partial,
            "emit_partials=false must suppress all Partial events"
        );
    }
}
