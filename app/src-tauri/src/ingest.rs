//! Audio import ("ingest") pipeline: validating a user-supplied audio file,
//! converting it to Myna's canonical 16 kHz mono WAV format, and re-running
//! transcription against an existing or newly imported recording.
//!
//! Backs `commands::import`'s `import_audio` (brand-new meeting from an
//! external file) and `retranscribe_meeting` (re-running STT over a
//! meeting's own or a freshly supplied audio source). Every public function
//! here is a pure or narrowly side-effecting helper — path validation
//! ([`validate_source_path`]), format conversion
//! ([`convert_to_canonical_wav`]), on-disk audio presence
//! ([`has_audio`]), previous-transcript preservation
//! ([`backup_transcript`]), re-import source resolution
//! ([`resolve_reimport_source`]), and the streaming transcribe loop itself
//! ([`transcribe_wav_streaming`]) — so each is unit-testable in isolation
//! from the Tauri commands that call it.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use myna_stt::{
    SimulatedStreamer, Speaker, StreamerOptions, SttEngine, SttEvent, Transcript,
    TranscriptSegment, VadConfig, WavBlockReader,
};

use crate::error::AppError;

/// Length, in seconds, of each block [`convert_to_canonical_wav`] reads and
/// resamples at a time, so a long import never loads the whole source file
/// into memory at once.
pub const INGEST_CHUNK_SEC: f32 = 1.0;

/// File extensions [`validate_source_path`] accepts as an import source,
/// compared case-insensitively.
pub const SUPPORTED_IMPORT_EXTENSIONS: &[&str] = &["wav"];

/// Filename [`backup_transcript`] writes under a meeting's directory.
const TRANSCRIPT_BACKUP_FILE: &str = "transcript.previous.json";

/// Pure guard for starting an audio import: `Busy` when an import is already
/// running, or when a recording is active (importing while recording would
/// race the recording's own `audio.wav` write). Mirrors
/// `crate::session::guard_start` / `guard_stop`.
pub fn guard_import(import_in_flight: bool, recording_active: bool) -> Result<(), AppError> {
    if import_in_flight {
        Err(AppError::Busy("an import is already in progress"))
    } else if recording_active {
        Err(AppError::Busy(
            "cannot import while a recording is in progress",
        ))
    } else {
        Ok(())
    }
}

/// Canonicalizes and validates a user-supplied source path for import.
///
/// Errors when: the path is missing, is not a file, its extension is not in
/// [`SUPPORTED_IMPORT_EXTENSIONS`] (case-insensitively), or the canonicalized
/// source path is the exact same file as `dest` — the path the caller is
/// about to write the (converted) audio to. This is a narrow self-overwrite
/// guard, not a blanket "anywhere under the meetings root" check: copying
/// one meeting's `audio.wav` in as the source for a *different*, brand-new
/// meeting is a different destination and must be allowed — that is what
/// `import_audio` always does, since `dest` there is a freshly minted
/// meeting id's `audio.wav`, which cannot yet equal any existing file.
/// `retranscribe_meeting`, by contrast, passes the *target* meeting's own
/// `audio.wav` as `dest`, so re-supplying that same meeting's audio as a
/// "replacement" source is correctly refused here.
pub fn validate_source_path(path: &Path, dest: &Path) -> Result<PathBuf, AppError> {
    if !path.exists() || !path.is_file() {
        return Err(AppError::Path(format!(
            "source path does not exist or is not a file: {}",
            display_file_name(path)
        )));
    }

    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_lowercase());
    match extension {
        Some(ext) if SUPPORTED_IMPORT_EXTENSIONS.contains(&ext.as_str()) => {}
        Some(ext) => {
            return Err(AppError::Path(format!(
                "unsupported source extension \"{ext}\"; supported extensions: {}",
                SUPPORTED_IMPORT_EXTENSIONS.join(", ")
            )));
        }
        None => {
            return Err(AppError::Path(format!(
                "source path has no extension: {}",
                display_file_name(path)
            )));
        }
    }

    let canonical_path = path
        .canonicalize()
        .map_err(|err| AppError::Path(format!("failed to canonicalize source path: {err}")))?;
    let canonical_dest = canonicalize_destination(dest)?;
    if canonical_path == canonical_dest {
        return Err(AppError::Path(format!(
            "source path {} is this meeting's own audio; use \"Re-transcribe from audio\" \
             instead of selecting a replacement file",
            display_file_name(&canonical_path)
        )));
    }

    Ok(canonical_path)
}

/// Canonicalizes an import/re-transcribe destination for the self-overwrite
/// comparison in [`validate_source_path`]. `dest` frequently does not exist
/// on disk yet — e.g. a brand-new meeting's `audio.wav` before conversion
/// has written it — so a plain `dest.canonicalize()` would fail even though
/// the path is perfectly well-formed. When `dest` exists, canonicalize it
/// directly; otherwise canonicalize its parent directory (which
/// `MeetingStore::create`/`save` always creates up front, before this is
/// ever called) and rejoin `dest`'s file name. Either way, a canonicalize
/// failure is propagated as [`AppError::Path`] rather than silently skipped.
fn canonicalize_destination(dest: &Path) -> Result<PathBuf, AppError> {
    if dest.exists() {
        return dest.canonicalize().map_err(|err| {
            AppError::Path(format!("failed to canonicalize destination path: {err}"))
        });
    }

    let parent = dest.parent().ok_or_else(|| {
        AppError::Path(format!(
            "destination path has no parent directory: {}",
            display_file_name(dest)
        ))
    })?;
    let canonical_parent = parent.canonicalize().map_err(|err| {
        AppError::Path(format!(
            "failed to canonicalize destination's parent directory: {err}"
        ))
    })?;
    let file_name = dest.file_name().ok_or_else(|| {
        AppError::Path(format!(
            "destination path has no file name: {}",
            display_file_name(dest)
        ))
    })?;
    Ok(canonical_parent.join(file_name))
}

/// Renders a path's file name only -- never its full path -- for
/// user-facing error messages. `ingest.rs`'s errors surface directly to the
/// Angular UI (and may end up in logs), so they must not leak the on-disk
/// layout: parent directories, the OS username embedded in `$HOME`, or the
/// `~/myna` data-root location. Falls back to a fixed placeholder for a path
/// with no file name component (e.g. `/`).
fn display_file_name(path: &Path) -> std::borrow::Cow<'_, str> {
    path.file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or(std::borrow::Cow::Borrowed("<unknown>"))
}

/// Converts any WAV (any sample rate, any channel count, int or float PCM)
/// at `src` into a canonical 16 kHz mono WAV at `dest`, streaming
/// [`INGEST_CHUNK_SEC`]-sized blocks rather than loading the whole file.
///
/// Writes to `dest.with_extension("wav.tmp")` first, then renames over
/// `dest`, so a failed conversion never destroys an existing `audio.wav`.
/// Returns the destination's duration in seconds.
///
/// Checks `cancel` between blocks (mirroring
/// [`transcribe_wav_streaming`]'s cancellation checks) and returns
/// [`AppError::Cancelled`] as soon as it observes it set; the tmp file
/// cleanup below runs for this error exactly like any other.
pub fn convert_to_canonical_wav(
    src: &Path,
    dest: &Path,
    cancel: &AtomicBool,
) -> Result<f32, AppError> {
    let tmp_path = dest.with_extension("wav.tmp");

    match convert_to_canonical_wav_inner(src, dest, &tmp_path, cancel) {
        Ok(frames_written) => Ok(frames_written as f32 / myna_audio::TARGET_SAMPLE_RATE as f32),
        Err(err) => {
            let _ = fs::remove_file(&tmp_path);
            Err(err)
        }
    }
}

/// Does the actual conversion work, writing to `tmp_path` and renaming over
/// `dest` only once every block has been written and the recorder has been
/// finalized. Returns the number of frames written. Any error here is
/// translated by [`convert_to_canonical_wav`] into cleanup of `tmp_path`
/// without touching `dest`.
fn convert_to_canonical_wav_inner(
    src: &Path,
    dest: &Path,
    tmp_path: &Path,
    cancel: &AtomicBool,
) -> Result<u64, AppError> {
    let mut reader = myna_stt::WavBlockReader::open(src)?;
    let block_frames = (reader.sample_rate() as f32 * INGEST_CHUNK_SEC) as usize;

    let mut resampler =
        myna_audio::Resampler::new(reader.sample_rate(), myna_audio::TARGET_SAMPLE_RATE)?;

    let recording_spec = myna_audio::RecordingSpec {
        sample_rate: myna_audio::TARGET_SAMPLE_RATE,
        channels: 1,
    };
    let mut recorder = myna_audio::WavRecorder::create(tmp_path, recording_spec)?;

    while let Some(block) = reader.next_block(block_frames)? {
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Cancelled);
        }

        let resampled = resampler.process(&block);
        if !resampled.is_empty() {
            recorder.write(&resampled)?;
        }
    }

    if cancel.load(Ordering::SeqCst) {
        return Err(AppError::Cancelled);
    }

    let tail = resampler.flush();
    if !tail.is_empty() {
        recorder.write(&tail)?;
    }

    let stats = recorder.finalize()?;
    fs::rename(tmp_path, dest)?;
    Ok(stats.frames)
}

/// Derives whether a meeting has recorded/imported audio, from the
/// filesystem rather than `Meeting::audio_path` (which currently has zero
/// callers and is always `None` on disk).
pub fn has_audio(audio_path: &Path) -> bool {
    audio_path.exists()
}

/// Backs up an existing transcript to `<meeting_dir>/transcript.previous.json`
/// before a re-transcribe overwrites it, so a bad re-transcription doesn't
/// silently destroy the previous result. `speaker_names` is snapshotted
/// alongside the transcript as an extra top-level field -- a re-transcribe
/// clears the live meeting's `speaker_names` (old labels may point at a
/// different person after re-clustering), so this backup is the only place
/// the old display names survive. Deserializing the backup as a plain
/// [`Transcript`] still round-trips exactly: `Transcript` has no
/// `deny_unknown_fields`, so the extra `speaker_names` key is ignored.
pub fn backup_transcript(
    meeting_dir: &Path,
    transcript: &Transcript,
    speaker_names: &BTreeMap<String, String>,
) -> Result<(), AppError> {
    fs::create_dir_all(meeting_dir)?;

    #[derive(serde::Serialize)]
    struct TranscriptBackup<'a> {
        segments: &'a [TranscriptSegment],
        speaker_names: &'a BTreeMap<String, String>,
    }
    let backup = TranscriptBackup {
        segments: &transcript.segments,
        speaker_names,
    };

    let json =
        serde_json::to_string_pretty(&backup).map_err(|err| AppError::Store(err.to_string()))?;
    let backup_path = meeting_dir.join(TRANSCRIPT_BACKUP_FILE);
    let tmp_path = meeting_dir.join(format!("{TRANSCRIPT_BACKUP_FILE}.tmp"));
    fs::write(&tmp_path, json)?;
    if let Err(err) = fs::rename(&tmp_path, &backup_path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(AppError::from(err));
    }
    Ok(())
}

/// Pure decision: resolves the source path a re-transcribe should read from.
/// An explicitly `supplied` path always wins; otherwise falls back to
/// `existing_audio` (the meeting's current `audio.wav`, when
/// [`has_audio`] is `true`); errors with [`AppError::NotFound`] when neither
/// is available.
pub fn resolve_reimport_source(
    existing_audio: Option<PathBuf>,
    supplied: Option<PathBuf>,
) -> Result<PathBuf, AppError> {
    supplied
        .or(existing_audio)
        .ok_or_else(|| AppError::NotFound("no existing audio and no source path supplied".into()))
}

/// Streams a canonical 16 kHz mono WAV at `path` through `streamer`, driving
/// it in [`INGEST_CHUNK_SEC`]-sized blocks via [`WavBlockReader`].
///
/// Invokes `on_event` for every [`SttEvent`] the streamer produces (both
/// while pushing blocks and on the final [`SimulatedStreamer::finish`]
/// flush) and `on_progress(processed_sec, total_sec)` once per block, after
/// that block's decode work has completed. Accumulates every
/// [`SttEvent::Final`] segment into the returned [`Transcript`] exactly the
/// way `myna-app`'s `session::spawn_decode_worker`/`apply_event` do, so
/// streamed-import transcripts are assembled identically to a live
/// recording's.
///
/// Checks `cancel` before reading each block; once it observes `cancel` set,
/// it stops immediately and returns `Err` without flushing the streamer or
/// returning a partial transcript — callers must persist nothing in that
/// case, leaving whatever was on disk before the call untouched.
pub fn transcribe_wav_streaming(
    path: &Path,
    streamer: &mut SimulatedStreamer,
    cancel: &AtomicBool,
    on_event: &mut dyn FnMut(SttEvent),
    on_progress: &mut dyn FnMut(f32, f32),
) -> Result<Transcript, AppError> {
    let mut reader = WavBlockReader::open(path)?;
    let sample_rate = reader.sample_rate();
    let total_sec = reader.total_frames() as f32 / sample_rate as f32;
    let block_frames = (sample_rate as f32 * INGEST_CHUNK_SEC) as usize;

    let mut transcript = Transcript::default();
    let mut processed_frames: u64 = 0;

    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(import_cancelled_error());
        }

        let Some(block) = reader.next_block(block_frames)? else {
            break;
        };
        let block_frame_count = block.len() as u64;

        for event in streamer.push(&block)? {
            accumulate_streamed_event(&mut transcript, &event);
            on_event(event);
        }

        processed_frames += block_frame_count;
        on_progress(processed_frames as f32 / sample_rate as f32, total_sec);
    }

    if cancel.load(Ordering::SeqCst) {
        return Err(import_cancelled_error());
    }

    for event in streamer.finish()? {
        accumulate_streamed_event(&mut transcript, &event);
        on_event(event);
    }

    Ok(transcript)
}

/// The error [`transcribe_wav_streaming`] returns once it observes
/// `cancel` set.
fn import_cancelled_error() -> AppError {
    AppError::Cancelled
}

/// Folds one [`SttEvent`] into `transcript`, mirroring
/// `myna-app`'s `session::apply_event` (by way of
/// `session::fold_track_event`): only [`SttEvent::Final`] segments are
/// accumulated; [`SttEvent::Partial`] events (never produced here, since
/// callers construct their [`SimulatedStreamer`] with `emit_partials:
/// false`) are ignored.
fn accumulate_streamed_event(transcript: &mut Transcript, event: &SttEvent) {
    if let SttEvent::Final { segment } = event {
        insert_final_segment(transcript, segment.clone());
    }
}

/// Inserts `segment` into `transcript.segments` at its sorted position by
/// `start_sec`, using a *stable* insert — segments sharing an equal
/// `start_sec` keep their arrival order — so the persisted transcript is
/// always ordered ascending by `start_sec` regardless of the order in which
/// segments across different tracks happen to finish decoding.
///
/// This matters beyond display order: [`Transcript::attributed_text`] merges
/// *consecutive* same-speaker segments, so an out-of-order transcript
/// produces wrong speaker groupings too — not just a cosmetically wrong
/// timeline.
///
/// Shared by [`accumulate_streamed_event`] (import/re-transcribe) and
/// `crate::session::fold_track_event` (live recording) so the two paths can
/// never diverge on this policy — see that function's docs for why live
/// decode-completion order across two tracks isn't chronological order.
///
/// A binary-search insert into a `Vec`, not a re-sort of the whole
/// transcript: this runs once per finalized segment on the decode worker,
/// and transcripts can reach thousands of segments.
pub fn insert_final_segment(transcript: &mut Transcript, segment: TranscriptSegment) {
    let insert_at = transcript.segments.partition_point(|existing| {
        existing.start_sec.total_cmp(&segment.start_sec) != std::cmp::Ordering::Greater
    });
    transcript.segments.insert(insert_at, segment);
}

/// One audio track a speaker-aware re-transcribe should decode, paired with
/// the [`Speaker`] every segment produced from it is stamped with.
#[derive(Debug, Clone)]
pub struct SpeakerTrack {
    pub path: PathBuf,
    pub speaker: Speaker,
}

/// Pure decision: resolves which per-track audio a re-transcribe should
/// decode from `mic_track`/`system_track`, in priority order:
///
/// 1. Both files exist on disk -> both are returned, each paired with its
///    own speaker ([`Speaker::me`] for `mic_track`, bare [`Speaker::others`]
///    for `system_track`).
/// 2. Exactly one exists -> only that one is returned, paired with its
///    speaker. The missing side is never synthesized.
/// 3. Neither exists -> an empty `Vec`, telling the caller to fall back to
///    the meeting's `audio.wav` instead, stamped [`Speaker::unknown`] -- see
///    [`transcribe_tracks_streaming`]'s docs for why that fallback is never
///    routed through this function itself.
///
/// A track file absent for a capture source that never populated it (see
/// `crate::session::source_has_mic`/`source_has_system`) is indistinguishable
/// here from a legacy meeting recorded before per-track capture existed --
/// both correctly degrade to "this track was never captured", never a
/// fabricated attribution.
pub fn resolve_retranscribe_tracks(mic_track: &Path, system_track: &Path) -> Vec<SpeakerTrack> {
    let mut tracks = Vec::new();
    if mic_track.exists() {
        tracks.push(SpeakerTrack {
            path: mic_track.to_path_buf(),
            speaker: Speaker::me(),
        });
    }
    if system_track.exists() {
        tracks.push(SpeakerTrack {
            path: system_track.to_path_buf(),
            speaker: Speaker::others(),
        });
    }
    tracks
}

/// Re-stamps a [`SttEvent::Final`]'s segment with `speaker`; passes a
/// [`SttEvent::Partial`] through unchanged (there is no per-segment speaker
/// to stamp on a partial hypothesis, and callers here always disable
/// partials via [`StreamerOptions::emit_partials`] anyway).
fn stamp_speaker_event(event: SttEvent, speaker: &Speaker) -> SttEvent {
    match event {
        SttEvent::Final { segment } => SttEvent::Final {
            segment: TranscriptSegment {
                speaker: speaker.clone(),
                ..segment
            },
        },
        partial @ SttEvent::Partial { .. } => partial,
    }
}

/// Speaker-aware counterpart to [`transcribe_wav_streaming`]: decodes every
/// [`SpeakerTrack`] in `tracks` with its own [`SimulatedStreamer`] -- all
/// sharing the single `engine` `Arc` (never a second loaded engine, which
/// would double RAM -- see `crate::session`'s module docs for the same
/// constraint on live recording) -- stamps each track's segments with its
/// paired [`Speaker`], and merges every track's segments into one
/// [`Transcript`] sorted ascending by `start_sec`.
///
/// `tracks` is expected non-empty; an empty slice yields an empty transcript
/// with zero duration. Callers resolve `tracks` via
/// [`resolve_retranscribe_tracks`] for the dual/single-track cases, or
/// build a single-element `Vec` themselves (stamped [`Speaker::unknown`])
/// for the "neither track file exists" fallback -- reading straight from a
/// meeting's `audio.wav`, which is native-rate stereo for new recordings but
/// mono for legacy ones; both shapes are handled identically here since
/// each track is read through the same [`transcribe_wav_streaming`] /
/// [`WavBlockReader`] pipeline that already downmixes and expects a
/// pre-resampled 16 kHz canonical WAV (callers must have already run that
/// fallback file through [`convert_to_canonical_wav`] before calling this).
///
/// Returns the merged transcript alongside the *maximum* of every track's
/// duration in seconds -- not the sum -- since tracks were captured in
/// parallel (the same wall-clock recording), not concatenated.
///
/// Checks `cancel` between blocks on every track (via
/// [`transcribe_wav_streaming`]'s own cancellation check) and stops as soon
/// as it observes it set, returning `Err` without merging any partial
/// per-track result.
pub fn transcribe_tracks_streaming(
    tracks: &[SpeakerTrack],
    engine: &Arc<SttEngine>,
    vad_cfg: &VadConfig,
    cancel: &AtomicBool,
    on_event: &mut dyn FnMut(SttEvent),
    on_progress: &mut dyn FnMut(f32, f32),
) -> Result<(Transcript, f32), AppError> {
    let mut durations = Vec::with_capacity(tracks.len());
    let mut progress_total_sec = 0.0f32;
    for track in tracks {
        let reader = WavBlockReader::open(&track.path)?;
        let duration = reader.total_frames() as f32 / reader.sample_rate() as f32;
        durations.push(duration);
        progress_total_sec += duration;
    }
    let duration_sec = durations.iter().copied().fold(0.0f32, f32::max);

    let mut per_track_transcripts: Vec<(Speaker, Transcript)> = Vec::with_capacity(tracks.len());
    let mut processed_before = 0.0f32;
    for (track, track_total) in tracks.iter().zip(durations.iter().copied()) {
        let mut streamer = SimulatedStreamer::with_options(
            Arc::clone(engine),
            vad_cfg,
            StreamerOptions {
                emit_partials: false,
            },
        )?;

        let speaker = track.speaker.clone();
        let mut stamped_on_event = |event: SttEvent| on_event(stamp_speaker_event(event, &speaker));
        let mut combined_on_progress = |processed_sec: f32, _track_total_sec: f32| {
            on_progress(processed_before + processed_sec, progress_total_sec);
        };

        let track_transcript = transcribe_wav_streaming(
            &track.path,
            &mut streamer,
            cancel,
            &mut stamped_on_event,
            &mut combined_on_progress,
        )?;

        per_track_transcripts.push((track.speaker.clone(), track_transcript));
        processed_before += track_total;
    }

    Ok((merge_track_transcripts(per_track_transcripts), duration_sec))
}

/// Stamps every segment of each `(speaker, transcript)` pair with its paired
/// `speaker`, then merges all of them into one [`Transcript`] sorted
/// ascending by `start_sec`. Pulled out of [`transcribe_tracks_streaming`]
/// as a pure function so the merge/stamp/sort policy that gives dual-track
/// re-transcribes their speaker attribution is directly unit-testable
/// without a loaded [`SttEngine`] -- see `tests/ingest.rs`.
pub fn merge_track_transcripts(per_track: Vec<(Speaker, Transcript)>) -> Transcript {
    let mut segments: Vec<TranscriptSegment> = Vec::new();
    for (speaker, transcript) in per_track {
        segments.extend(
            transcript
                .segments
                .into_iter()
                .map(|segment| TranscriptSegment {
                    speaker: speaker.clone(),
                    ..segment
                }),
        );
    }
    segments.sort_by(|a, b| a.start_sec.total_cmp(&b.start_sec));
    Transcript { segments }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- guard_import ---------------------------------------------------

    #[test]
    fn guard_import_allows_when_nothing_is_in_flight() {
        // Arrange / Act
        let result = guard_import(false, false);

        // Assert
        assert!(result.is_ok());
    }

    #[test]
    fn guard_import_rejects_when_an_import_is_already_running() {
        // Act
        let err = guard_import(true, false).expect_err("should be busy");

        // Assert: variant is Busy, and the message names *this* conflict.
        assert!(matches!(err, AppError::Busy(_)));
        let message = err.to_string();
        assert!(
            message.to_lowercase().contains("import"),
            "message should name the import conflict, got: {message}"
        );
    }

    #[test]
    fn guard_import_rejects_when_a_recording_is_active() {
        // Act
        let err = guard_import(false, true).expect_err("should be busy");

        // Assert: variant is Busy, and the message names *this* conflict.
        assert!(matches!(err, AppError::Busy(_)));
        let message = err.to_string();
        assert!(
            message.to_lowercase().contains("recording"),
            "message should name the recording conflict, got: {message}"
        );
    }

    #[test]
    fn guard_import_rejects_when_both_import_and_recording_are_active() {
        // Act
        let err = guard_import(true, true).expect_err("should be busy");

        // Assert
        assert!(matches!(err, AppError::Busy(_)));
    }

    // --- validate_source_path --------------------------------------------

    #[test]
    fn validate_source_path_rejects_a_missing_file() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("meetings/some-id/audio.wav");
        let missing = dir.path().join("does-not-exist.wav");

        // Act
        let result = validate_source_path(&missing, &dest);

        // Assert
        assert!(result.is_err(), "a missing path must not validate");
    }

    #[test]
    fn validate_source_path_rejects_a_directory() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("meetings/some-id/audio.wav");
        let sub_dir = dir.path().join("a-directory.wav");
        std::fs::create_dir_all(&sub_dir).expect("create dir fixture");

        // Act
        let result = validate_source_path(&sub_dir, &dest);

        // Assert
        assert!(
            result.is_err(),
            "a directory (even with a .wav name) must not validate as a source file"
        );
    }

    #[test]
    fn validate_source_path_rejects_an_unsupported_extension_and_names_it() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("meetings/some-id/audio.wav");
        let mp3 = dir.path().join("recording.mp3");
        std::fs::write(&mp3, b"not really an mp3").expect("write fixture");

        // Act
        let err = validate_source_path(&mp3, &dest).expect_err("mp3 must be rejected");

        // Assert: message names the offending extension AND the supported ones.
        let message = err.to_string().to_lowercase();
        assert!(
            message.contains("mp3"),
            "message should name the offending extension, got: {message}"
        );
        assert!(
            message.contains("wav"),
            "message should list the supported extensions, got: {message}"
        );
    }

    #[test]
    fn validate_source_path_rejects_a_path_with_no_extension() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("meetings/some-id/audio.wav");
        let no_ext = dir.path().join("recording");
        std::fs::write(&no_ext, b"data").expect("write fixture");

        // Act
        let result = validate_source_path(&no_ext, &dest);

        // Assert
        assert!(result.is_err(), "a path with no extension must be rejected");
    }

    #[test]
    fn validate_source_path_accepts_uppercase_wav_extension_case_insensitively() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");
        let meeting_dir = dir.path().join("meetings/some-id");
        std::fs::create_dir_all(&meeting_dir).expect("create meeting dir fixture");
        let dest = meeting_dir.join("audio.wav");
        let uppercase_wav = dir.path().join("RECORDING.WAV");
        std::fs::write(&uppercase_wav, b"RIFF....WAVEfmt ").expect("write fixture");

        // Act
        let result = validate_source_path(&uppercase_wav, &dest);

        // Assert
        assert!(
            result.is_ok(),
            "uppercase .WAV must validate case-insensitively, got: {result:?}"
        );
    }

    // --- validate_source_path: narrowed self-overwrite guard (bug report:
    // "if we select an audio who is already in a ~/myna/meetings/{id}
    // folder, it doesn't seem to ingest it") -----------------------------

    #[test]
    fn validate_source_path_accepts_a_file_already_inside_the_meetings_root_when_it_is_not_the_destination(
    ) {
        // Arrange: this is the reported bug. `other_meeting_audio` lives
        // under `<meetings_root>/<some-uuid>/audio.wav` — exactly the shape
        // that used to be blanket-rejected by the old
        // `starts_with(meetings_root)` containment check — but the caller
        // (a brand-new import) is writing to a *different* meeting's
        // destination, so this must now be accepted.
        //
        // Confirmed this fails against the pre-fix code: the old
        // `validate_source_path(path, meetings_root)` rejected any path
        // under `meetings_root` unconditionally, regardless of `dest`.
        let dir = tempfile::tempdir().expect("tempdir");
        let meetings_root = dir.path().join("meetings");
        let other_meeting_dir = meetings_root.join("11111111-1111-1111-1111-111111111111");
        std::fs::create_dir_all(&other_meeting_dir).expect("create other meeting dir fixture");
        let other_meeting_audio = other_meeting_dir.join("audio.wav");
        std::fs::write(&other_meeting_audio, b"RIFF....WAVEfmt ").expect("write fixture");

        // The new meeting's destination: a different, freshly created
        // meeting directory under the same meetings root.
        let new_meeting_dir = meetings_root.join("22222222-2222-2222-2222-222222222222");
        std::fs::create_dir_all(&new_meeting_dir).expect("create new meeting dir fixture");
        let new_meeting_dest = new_meeting_dir.join("audio.wav");

        // Act
        let result = validate_source_path(&other_meeting_audio, &new_meeting_dest);

        // Assert
        assert!(
            result.is_ok(),
            "a source file that lives under the meetings root, but is not the destination \
             itself, must be accepted for import into a different meeting, got: {result:?}"
        );
    }

    #[test]
    fn validate_source_path_refuses_a_meetings_own_audio_supplied_as_its_own_replacement_source() {
        // Arrange: the narrowed guard still must bite for TRUE
        // self-overwrite — re-supplying a meeting's own `audio.wav` as the
        // replacement source for re-transcribing *that same meeting*.
        let dir = tempfile::tempdir().expect("tempdir");
        let meeting_dir = dir.path().join("meetings/some-meeting-id");
        std::fs::create_dir_all(&meeting_dir).expect("create meeting dir fixture");
        let audio_path = meeting_dir.join("audio.wav");
        std::fs::write(&audio_path, b"RIFF....WAVEfmt ").expect("write fixture");

        // Act: source and dest are the exact same file.
        let err = validate_source_path(&audio_path, &audio_path)
            .expect_err("supplying a meeting's own audio as its own replacement must be refused");

        // Assert: message is specific and actionable, naming the conflict
        // and pointing at the safe alternative.
        assert!(matches!(err, AppError::Path(_)));
        let message = err.to_string();
        assert!(
            message.contains("Re-transcribe from audio"),
            "message should point the user at \"Re-transcribe from audio\", got: {message}"
        );
    }

    // --- validate_source_path: canonicalize failure must not be silently
    // skipped (code-review LOW finding 7) ---------------------------------

    #[test]
    fn validate_source_path_errors_when_destinations_parent_does_not_exist() {
        // Arrange: dest's parent directory is never created, so
        // canonicalize_destination's `parent.canonicalize()` fails with a
        // filesystem error rather than resolving to a path.
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("meetings-does-not-exist/some-id/audio.wav");
        let source = dir.path().join("recording.wav");
        std::fs::write(&source, b"RIFF....WAVEfmt ").expect("write fixture");

        // Act
        let result = validate_source_path(&source, &dest);

        // Assert: a destination whose parent fails to canonicalize must
        // surface as a path error, not silently skip the self-overwrite
        // check and return Ok.
        assert!(
            matches!(result, Err(AppError::Path(_))),
            "expected AppError::Path when dest's parent fails to canonicalize, got: {result:?}"
        );
    }

    // --- convert_to_canonical_wav: cancellation-awareness (code-review HIGH
    // finding 3) -----------------------------------------------------------

    /// Writes a minimal, valid mono WAV fixture with `seconds` of silence at
    /// `sample_rate`, long enough to span at least one
    /// `convert_to_canonical_wav` block (`INGEST_CHUNK_SEC`).
    fn write_wav_fixture(path: &Path, seconds: f32, sample_rate: u32) {
        let spec = myna_audio::RecordingSpec {
            sample_rate,
            channels: 1,
        };
        let mut recorder =
            myna_audio::WavRecorder::create(path, spec).expect("create wav recorder fixture");
        let frame_count = (sample_rate as f32 * seconds) as usize;
        recorder
            .write(&vec![0.01_f32; frame_count])
            .expect("write wav fixture samples");
        recorder.finalize().expect("finalize wav fixture");
    }

    #[test]
    fn convert_to_canonical_wav_returns_cancelled_and_writes_nothing_when_cancelled() {
        // Arrange: a source WAV spanning several INGEST_CHUNK_SEC blocks, and
        // a cancellation flag already set before conversion starts.
        let dir = tempfile::tempdir().expect("tempdir");
        let src = dir.path().join("source.wav");
        write_wav_fixture(&src, 3.0, 16_000);
        let dest = dir.path().join("audio.wav");
        let cancel = AtomicBool::new(true);

        // Act
        let result = convert_to_canonical_wav(&src, &dest, &cancel);

        // Assert
        assert!(
            matches!(result, Err(AppError::Cancelled)),
            "expected AppError::Cancelled, got: {result:?}"
        );
        assert!(
            !dest.exists(),
            "a cancelled conversion must never create the destination file"
        );
        let tmp_path = dest.with_extension("wav.tmp");
        assert!(
            !tmp_path.exists(),
            "a cancelled conversion must clean up its own tmp file"
        );
    }

    #[test]
    fn convert_to_canonical_wav_cancelled_while_replacing_audio_leaves_the_existing_file_untouched()
    {
        // Arrange: `dest` here stands in for a meeting's *existing*
        // audio.wav. The replace-audio re-transcribe path must convert the
        // newly supplied source into a *separate staging path* — never
        // `dest` itself — so a cancellation mid-conversion can't desync
        // on-disk audio from the (still-intact) previous transcript. This
        // pins that safety property directly: `dest` is pre-seeded with
        // known bytes and is never passed as `convert_to_canonical_wav`'s
        // destination.
        let dir = tempfile::tempdir().expect("tempdir");
        let src = dir.path().join("new-source.wav");
        write_wav_fixture(&src, 3.0, 16_000);

        let dest = dir.path().join("audio.wav");
        let original_bytes = b"ORIGINAL-AUDIO-BYTES-PRE-EXISTING";
        std::fs::write(&dest, original_bytes).expect("seed pre-existing audio.wav");

        let staged = dest.with_extension("wav.staged");
        let cancel = AtomicBool::new(true);

        // Act: mirrors what `run_retranscribe`'s replace-audio branch must
        // do under cancellation — convert into `staged`, never `dest`.
        let result = convert_to_canonical_wav(&src, &staged, &cancel);

        // Assert
        assert!(matches!(result, Err(AppError::Cancelled)));
        assert!(
            !staged.exists(),
            "the staged replacement file must not exist after a cancelled conversion"
        );
        let dest_bytes = std::fs::read(&dest).expect("original audio.wav must still exist");
        assert_eq!(
            dest_bytes, original_bytes,
            "the meeting's existing audio.wav must be byte-identical after a cancelled \
             replace-audio conversion"
        );
    }

    // --- backup_transcript: tmp cleanup on a failed rename (code-review LOW
    // finding 9) -------------------------------------------------------------

    #[test]
    fn backup_transcript_cleans_up_its_tmp_file_when_the_rename_fails() {
        // Arrange: make the rename *destination* an existing directory, so
        // `fs::rename(tmp_path, backup_path)` fails (renaming a file over a
        // directory is always an error).
        let dir = tempfile::tempdir().expect("tempdir");
        let meeting_dir = dir.path().join("meeting");
        fs::create_dir_all(&meeting_dir).expect("create meeting dir fixture");
        let backup_path = meeting_dir.join(TRANSCRIPT_BACKUP_FILE);
        fs::create_dir_all(&backup_path).expect("make the backup path an existing directory");

        let transcript = Transcript::default();

        // Act
        let result = backup_transcript(&meeting_dir, &transcript, &BTreeMap::new());

        // Assert
        assert!(
            result.is_err(),
            "renaming onto an existing directory must fail"
        );
        let tmp_path = meeting_dir.join(format!("{TRANSCRIPT_BACKUP_FILE}.tmp"));
        assert!(
            !tmp_path.exists(),
            "backup_transcript must clean up its tmp file when the rename fails, mirroring \
             convert_to_canonical_wav's cleanup-on-error discipline"
        );
    }
}
