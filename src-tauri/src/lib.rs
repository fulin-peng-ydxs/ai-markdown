use tauri::Manager;

pub mod commands;
pub mod error;
pub mod fs;
pub mod menu;
pub mod state;
pub mod window;

#[cfg(test)]
mod contract_test;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::workspace::WorkspaceAccessService::default())
        .manage(fs::scan::WorkspaceScanService::default())
        .menu(menu::build_app_menu)
        .on_menu_event(|app, event| menu::handle_menu_event(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            commands::workspace::select_workspace_folder,
            commands::workspace::select_markdown_file,
            commands::workspace::authorize_workspace_selection,
            commands::workspace::cancel_workspace_selection,
            commands::workspace::validate_recent_workspace,
            commands::files::start_workspace_scan,
            commands::files::poll_workspace_scan,
            commands::files::cancel_workspace_scan,
            commands::files::read_markdown_file,
        ])
        .setup(|app| {
            let persistent_state = state::PersistentAppState::initialize_for_app(app.handle());
            if let Some(error) = persistent_state.current_error() {
                eprintln!(
                    "Plainroot state initialization failed: {}",
                    error.message_key
                );
            }
            app.manage(persistent_state);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Plainroot desktop shell");
}
