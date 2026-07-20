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
    let mutations = fs::mutate::WorkspaceMutationService::default();
    let deletions =
        fs::delete::WorkspaceDeleteService::with_operation_lock(mutations.operation_lock());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::workspace::WorkspaceAccessService::default())
        .manage(fs::scan::WorkspaceScanService::default())
        .manage(fs::watch::WorkspaceWatchService::default())
        .manage(mutations)
        .manage(deletions)
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
            commands::files::start_workspace_watch,
            commands::files::restart_workspace_watch,
            commands::files::poll_workspace_watch,
            commands::files::stop_workspace_watch,
            commands::files::read_markdown_file,
            commands::files::safe_write_markdown_file,
            commands::files::create_markdown_file,
            commands::files::create_workspace_directory,
            commands::files::rename_workspace_entry,
            commands::files::move_workspace_entry,
            commands::files::trash_workspace_entry,
            commands::files::prepare_permanent_delete,
            commands::files::confirm_permanent_delete,
            commands::files::cancel_permanent_delete,
            commands::files::reveal_workspace_entry,
        ])
        .setup(|app| {
            let persistent_state = state::PersistentAppState::initialize_for_app(app.handle());
            let cleanup_roots = persistent_state
                .snapshot()
                .map(|state| {
                    state
                        .recent_workspaces
                        .into_iter()
                        .map(|workspace| workspace.canonical_root)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if let Some(error) = persistent_state.current_error() {
                eprintln!(
                    "Plainroot state initialization failed: {}",
                    error.message_key
                );
            }
            app.manage(persistent_state);
            let operation_lock = app
                .state::<fs::mutate::WorkspaceMutationService>()
                .operation_lock();
            let safe_writes = fs::safe_write::WorkspaceSafeWriteService::initialize_for_app(
                app.handle(),
                operation_lock,
                cleanup_roots,
            );
            if let Some(error) = safe_writes.current_error() {
                eprintln!(
                    "Plainroot safe-write initialization failed: {}",
                    error.message_key
                );
            }
            app.manage(safe_writes);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Plainroot desktop shell");
}
