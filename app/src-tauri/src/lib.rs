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
pub mod menu;
pub mod model_init;
pub mod paths;
pub mod recovery;
pub mod session;
pub mod session_manifest;
pub mod state;
pub mod store;
pub mod summary_prefs;
pub mod update_prefs;

use std::sync::Arc;

use tauri::Manager;

use crate::model_init::ModelDownloadManager;
use crate::state::AppState;
use crate::store::folder_store::FsFolderStore;
use crate::store::fs_store::FsMeetingStore;

/// Build and run the Tauri application.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            // Fixed, version-free User-Agent: a per-version string would
            // make every update-check request a fingerprint of exactly
            // which build is asking. `pubkey`/`endpoints` come from
            // `tauri.conf.json` (`plugins.updater`), not here.
            tauri_plugin_updater::Builder::new()
                .header("User-Agent", "Myna")
                .expect("\"Myna\" is a valid header value")
                .build(),
        )
        .setup(|app| {
            let root = paths::data_root()?;
            if let Err(err) = paths::harden_existing_data_root(&root) {
                eprintln!("failed to harden pre-existing data root permissions: {err}");
            }
            let store = FsMeetingStore::new(root.clone());
            // ADR 0011: every `session.json` manifest found at this point is
            // an orphan — no session can exist yet in this process. Fold each
            // one back into a real meeting before anything can observe (or
            // overwrite) it. The same scan also repairs pre-ADR-0011 legacy
            // orphans (no manifest, 0 s meeting, placeholder-header WAV).
            // Best-effort and never blocks boot.
            recovery::recover_orphaned_sessions(&store);
            let folders = FsFolderStore::new(root);
            app.manage(AppState::new(store, folders));
            app.manage(Arc::new(ModelDownloadManager::new()));
            // Replace tauri's auto-generated default menu (only installed
            // while `app.menu.is_none()`) with ours: same items, plus
            // "Settings…" emitting events::MENU_SETTINGS.
            app.set_menu(menu::build(app.handle())?)?;
            Ok(())
        })
        .on_menu_event(|app, event| menu::handle(app, &event))
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
            commands::recording::get_live_transcript,
            commands::import::import_audio,
            commands::import::retranscribe_meeting,
            commands::import::cancel_import,
            commands::import::diarize_meeting,
            commands::meetings::list_meetings,
            commands::meetings::get_meeting,
            commands::meetings::delete_meeting,
            commands::meetings::get_transcript,
            commands::meetings::get_meeting_audio_path,
            commands::meetings::rename_meeting,
            commands::meetings::set_meeting_archived,
            commands::meetings::edit_transcript_segment,
            commands::meetings::delete_transcript_segment,
            commands::meetings::merge_transcript_segment_up,
            commands::meetings::restore_transcript_segments,
            commands::meetings::rename_speaker,
            commands::meetings::remove_speaker,
            commands::meetings::set_segment_speaker,
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
            commands::summary::delete_summary,
            commands::summary::get_summary_guidelines,
            commands::summary::set_summary_guidelines,
            commands::models::models_status,
            commands::models::start_model_download,
            commands::models::start_diarization_download,
            commands::models::cancel_model_download,
            commands::export::export_meeting,
            commands::updates::update_consent,
            commands::updates::set_update_consent,
            commands::updates::check_for_update,
            commands::update_install::install_update,
            commands::update_install::restart_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running myna-app");
}
