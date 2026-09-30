//! Windows WASAPI loopback backend for system-audio capture.
//!
//! Captures the shared mix of the default render endpoint through
//! `AUDCLNT_STREAMFLAGS_LOOPBACK`: whatever the user hears, at the mix
//! format's native rate, discovered at open time rather than assumed.
//! Loopback has no per-application selectivity, so every source id —
//! including stale ones — resolves to the synthetic all-output source, and
//! per-application enumeration stays empty
//! ([`crate::system::list_system_audio_sources`] still reports its own
//! all-output entry, so the picker shows exactly one row).
//!
//! Loopback capture needs no user permission on Windows, so
//! [`system_audio_status`] reports `Available` whenever a default render
//! endpoint exists and `Unavailable` otherwise; there is nothing to prompt
//! for, so [`request_system_audio_permission`] just re-reads that status.
//!
//! All `unsafe` WASAPI calls live in `myna-wasapi-probe`'s safe
//! [`myna_wasapi_probe::LoopbackCapture`] surface (the Windows counterpart
//! to `myna-coreaudio-tap` on macOS); this module only shapes its raw
//! interleaved frames into [`SystemAudioBlock`]s and owns the duck-typed
//! capture handle.

use crate::error::AudioError;
use crate::resample::downmix_to_mono;
use crate::system::{SystemAudioBlock, SystemAudioSource, SystemAudioStatus};

/// Reason reported when no default output device exists to loop back.
const NO_DEFAULT_OUTPUT_REASON: &str =
    "no default audio output device is available for loopback capture";

pub(crate) fn system_audio_status() -> SystemAudioStatus {
    if myna_wasapi_probe::default_render_available() {
        SystemAudioStatus::Available
    } else {
        SystemAudioStatus::Unavailable {
            reason: NO_DEFAULT_OUTPUT_REASON.to_string(),
        }
    }
}

pub(crate) fn request_system_audio_permission() -> SystemAudioStatus {
    system_audio_status()
}

/// No per-application enumeration on Windows loopback: [`crate::system`]'s
/// [`crate::system::list_system_audio_sources`] still reports the
/// all-output entry it adds itself, so callers always see at least one
/// source.
pub(crate) fn list_running_application_sources() -> Vec<SystemAudioSource> {
    Vec::new()
}

/// Reduces interleaved multi-channel frames to genuine stereo: mono
/// duplicates to both channels, stereo passes through, wider mixes keep
/// their front-left/front-right pair.
fn stereo_from_interleaved(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        let mut stereo = Vec::with_capacity(interleaved.len() * 2);
        for &sample in interleaved {
            stereo.push(sample);
            stereo.push(sample);
        }
        return stereo;
    }
    if channels == 2 {
        return interleaved.to_vec();
    }
    let mut stereo = Vec::with_capacity(interleaved.len() / channels * 2);
    for frame in interleaved.chunks(channels) {
        stereo.push(frame.first().copied().unwrap_or(0.0));
        stereo.push(frame.get(1).copied().unwrap_or(0.0));
    }
    stereo
}

/// A running WASAPI loopback system-audio capture.
pub(crate) struct SystemAudioCapture {
    inner: myna_wasapi_probe::LoopbackCapture,
}

impl SystemAudioCapture {
    /// Starts looping back the default render mix, delivering a
    /// [`SystemAudioBlock`] to `on_pcm` per engine packet — the mono
    /// reduction (as always) alongside genuine native-rate interleaved
    /// stereo — on the backend-owned thread, never the calling thread.
    /// Returns the mix format's actual rate alongside the handle and the
    /// [`SystemAudioSource`] actually captured (always all-output; see
    /// this module's docs).
    pub(crate) fn start(
        system_source: Option<&str>,
        mut on_pcm: impl FnMut(&SystemAudioBlock<'_>) + Send + 'static,
    ) -> Result<(Self, SystemAudioSource, u32), AudioError> {
        if let Some(id) = system_source.filter(|id| *id != crate::system::ALL_OUTPUT_SOURCE_ID) {
            #[cfg(debug_assertions)]
            eprintln!("myna-audio: stale system-audio source '{id}'; falling back to all output");
        }
        let effective_source = SystemAudioSource::all_output();
        let (inner, actual_rate, channels) =
            myna_wasapi_probe::LoopbackCapture::start(move |interleaved: &[f32], channels: u16| {
                let mono = downmix_to_mono(interleaved, channels);
                let stereo = stereo_from_interleaved(interleaved, usize::from(channels));
                if mono.is_empty() && stereo.is_empty() {
                    return;
                }
                on_pcm(&SystemAudioBlock {
                    mono: &mono,
                    stereo: &stereo,
                });
            })
            .map_err(AudioError::SystemAudioUnavailable)?;
        // Debug-only: effective source names the looped-back mix, which
        // must never be disclosed in a release build's stderr/log capture.
        #[cfg(debug_assertions)]
        eprintln!(
            "myna-audio: WASAPI loopback started (source: {effective_source:?}, native \
             sample rate: {actual_rate} Hz, channels: {channels})"
        );
        Ok((Self { inner }, effective_source, actual_rate))
    }

    /// Stops the capture. Dropping a [`SystemAudioCapture`] without calling
    /// this also stops it, via [`myna_wasapi_probe::LoopbackCapture`]'s own
    /// `Drop`.
    pub(crate) fn stop(self) -> Result<(), AudioError> {
        self.inner.stop();
        Ok(())
    }

    /// Polls the default render endpoint's peak meter for stall detection:
    /// a loopback stream keeps delivering (silent) packets on schedule even
    /// when nothing renders, so buffer content alone can't tell a stalled
    /// capture from a genuinely quiet one apart — this can. Rate-limited to
    /// 1Hz by the caller (see [`crate::mixer::RENDERING_QUERY_MIN_INTERVAL`]),
    /// never called on a realtime thread.
    pub(crate) fn is_any_tapped_process_rendering_output(&self) -> bool {
        myna_wasapi_probe::is_loopback_rendering()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stereo_from_mono_duplicates_to_both_channels() {
        let stereo = stereo_from_interleaved(&[0.5, -0.25], 1);

        assert_eq!(stereo, vec![0.5, 0.5, -0.25, -0.25]);
    }

    #[test]
    fn stereo_from_stereo_passes_through() {
        let interleaved = vec![0.1, 0.2, 0.3, 0.4];

        assert_eq!(stereo_from_interleaved(&interleaved, 2), interleaved);
    }

    #[test]
    fn stereo_from_multichannel_keeps_the_front_pair() {
        let interleaved = vec![
            1.0, 2.0, 3.0, 4.0, 5.0, 6.0, // 5.1 frame one
            7.0, 8.0, 9.0, 10.0, 11.0, 12.0, // 5.1 frame two
        ];

        assert_eq!(
            stereo_from_interleaved(&interleaved, 6),
            vec![1.0, 2.0, 7.0, 8.0]
        );
    }

    #[test]
    fn stereo_from_empty_stays_empty() {
        assert!(stereo_from_interleaved(&[], 2).is_empty());
    }
}
