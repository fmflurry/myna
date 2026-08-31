//! Tauri 2 desktop shell for Myna: window/webview wiring, application
//! state, and the recording/meeting/summarization command surface.
//!
//! `paths` resolves the on-disk locations the rest of the app (data root,
//! models, templates) read from and write to.

pub mod commands;
pub mod domain;
pub mod dto;
pub mod error;
pub mod events;
pub mod ingest;
pub mod paths;
pub mod session;
pub mod state;
pub mod store;

use tauri::Manager;

use crate::state::AppState;
use crate::store::folder_store::FsFolderStore;
use crate::store::fs_store::FsMeetingStore;

/// Build and run the Tauri application.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let root = paths::data_root()?;
            let store = FsMeetingStore::new(root.clone());
            let folders = FsFolderStore::new(root);
            app.manage(AppState::new(store, folders));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info::app_version,
            commands::devices::list_input_devices,
            commands::devices::default_input_device,
            commands::devices::list_output_devices,
            commands::devices::default_output_device,
            commands::devices::system_audio_status,
            commands::devices::request_system_audio_permission,
            commands::devices::list_audio_sources,
            commands::recording::start_recording,
            commands::recording::stop_recording,
            commands::recording::cancel_recording,
            commands::recording::recording_state,
            commands::import::import_audio,
            commands::import::retranscribe_meeting,
            commands::import::cancel_import,
            commands::import::diarize_meeting,
            commands::meetings::list_meetings,
            commands::meetings::get_meeting,
            commands::meetings::delete_meeting,
            commands::meetings::get_transcript,
            commands::meetings::rename_meeting,
            commands::meetings::set_meeting_archived,
            commands::meetings::edit_transcript_segment,
            commands::folders::list_folders,
            commands::folders::create_folder,
            commands::folders::rename_folder,
            commands::folders::delete_folder,
            commands::folders::set_meeting_folder,
            commands::placement::set_meeting_placement,
            commands::templates::list_templates,
            commands::languages::list_summary_languages,
            commands::summary::summarize_meeting,
            commands::summary::cancel_summarization,
            commands::summary::get_summary,
            commands::summary::edit_summary,
            commands::models::models_status,
            commands::models::download_command,
            commands::export::export_meeting,
        ])
        .run(tauri::generate_context!())
        .expect("error while running myna-app");
}
