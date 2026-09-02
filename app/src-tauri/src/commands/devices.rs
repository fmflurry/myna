//! Audio input device listing and system-audio permission commands.
//!
//! Every command here is an `async fn` that hands the actual `myna_audio`
//! call to [`tauri::async_runtime::spawn_blocking`]: these round-trip to
//! CoreAudio/HAL (`coreaudiod` on macOS), which can block for an
//! unpredictable time — [`request_system_audio_permission`] in particular
//! now performs a real capture attempt and may wait on an OS permission
//! prompt.

use myna_audio::DeviceInfo;
use tauri::State;

use crate::dto::{AudioSourceDto, SystemAudioStatusDto};
use crate::error::AppError;
use crate::state::AppState;

/// Lists all available audio input devices.
///
/// Doubles as the app's periodic idle-model-eviction tick: the UI's
/// `DevicesFacade` polls this command every 5 s for the lifetime of the
/// meetings module, so [`AppState::evict_stt_if_idle`] runs here instead
/// of introducing a dedicated timer. The check is non-blocking (all
/// `try_lock`s) and refuses while a recording or import holds the engine,
/// so a warm-poll tick costs microseconds; the real release only happens
/// once [`crate::state::IDLE_MODEL_TTL`] has elapsed since last use.
#[tauri::command]
pub async fn list_input_devices(state: State<'_, AppState>) -> Result<Vec<DeviceInfo>, AppError> {
    state.evict_stt_if_idle();
    tauri::async_runtime::spawn_blocking(|| Ok(myna_audio::list_input_devices()?))
        .await
        .unwrap_or_else(|_| {
            Err(AppError::Store(
                "list_input_devices worker thread panicked".to_string(),
            ))
        })
}

/// Returns the host's default audio input device.
#[tauri::command]
pub async fn default_input_device() -> Result<DeviceInfo, AppError> {
    tauri::async_runtime::spawn_blocking(|| Ok(myna_audio::default_input_device()?))
        .await
        .unwrap_or_else(|_| {
            Err(AppError::Store(
                "default_input_device worker thread panicked".to_string(),
            ))
        })
}

/// Lists all available audio output devices.
#[tauri::command]
pub async fn list_output_devices() -> Result<Vec<DeviceInfo>, AppError> {
    tauri::async_runtime::spawn_blocking(|| Ok(myna_audio::list_output_devices()?))
        .await
        .unwrap_or_else(|_| {
            Err(AppError::Store(
                "list_output_devices worker thread panicked".to_string(),
            ))
        })
}

/// Returns the host's default audio output device.
#[tauri::command]
pub async fn default_output_device() -> Result<DeviceInfo, AppError> {
    tauri::async_runtime::spawn_blocking(|| Ok(myna_audio::default_output_device()?))
        .await
        .unwrap_or_else(|_| {
            Err(AppError::Store(
                "default_output_device worker thread panicked".to_string(),
            ))
        })
}

/// Reports whether system-audio capture is currently available, without
/// prompting the user.
#[tauri::command]
pub async fn system_audio_status() -> SystemAudioStatusDto {
    tauri::async_runtime::spawn_blocking(|| {
        SystemAudioStatusDto::from(myna_audio::system_audio_status())
    })
    .await
    .unwrap_or_else(|_| SystemAudioStatusDto::Unavailable {
        reason: "system_audio_status worker thread panicked".to_string(),
    })
}

/// Prompts the OS to grant system-audio capture permission, if the
/// platform supports such a prompt, and returns the resulting status.
#[tauri::command]
pub async fn request_system_audio_permission() -> SystemAudioStatusDto {
    tauri::async_runtime::spawn_blocking(|| {
        SystemAudioStatusDto::from(myna_audio::request_system_audio_permission())
    })
    .await
    .unwrap_or_else(|_| SystemAudioStatusDto::Unavailable {
        reason: "request_system_audio_permission worker thread panicked".to_string(),
    })
}

/// Lists the system-audio sources capturable on this machine: the
/// synthetic all-output source first, then one entry per running
/// application that can produce audio. On a platform (or in a state) with
/// no per-application enumeration, this still returns at least the
/// all-output entry — never an error.
#[tauri::command]
pub async fn list_audio_sources() -> Vec<AudioSourceDto> {
    tauri::async_runtime::spawn_blocking(|| {
        myna_audio::list_system_audio_sources()
            .into_iter()
            .map(AudioSourceDto::from)
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default()
}
