use tauri::Manager;

pub(crate) fn app_data_directory<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<std::path::PathBuf, tauri::Error> {
    #[cfg(feature = "e2e")]
    if let Some(path) = std::env::var_os("PLAINROOT_E2E_DATA_DIR") {
        // The WebDriver runner creates and removes this directory for every suite. Production
        // builds compile this branch out and always use the operating-system application path.
        return Ok(std::path::PathBuf::from(path));
    }
    app.path().app_data_dir()
}

pub mod commands;
pub mod error;
pub mod fs;
pub mod menu;
pub mod state;
pub mod window;

#[cfg(test)]
mod contract_test;
#[cfg(test)]
pub(crate) mod test_support;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mutations = fs::mutate::WorkspaceMutationService::default();
    let deletions =
        fs::delete::WorkspaceDeleteService::with_operation_lock(mutations.operation_lock());
    let builder = tauri::Builder::default();
    #[cfg(any(target_os = "macos", windows))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, arguments, cwd| {
        if let Some(coordinator) = app.try_state::<window::WorkspaceWindowCoordinator>() {
            if let Err(error) = coordinator.enqueue_second_instance_request(arguments, cwd) {
                eprintln!(
                    "Plainroot second-instance forwarding failed: {}",
                    error.message_key
                );
            }
        }
        if let Err(error) = window::focus_any_window(app) {
            eprintln!(
                "Plainroot second-instance focus failed: {}",
                error.message_key
            );
        }
    }));
    // The embedded WebDriver is compiled only for the dedicated E2E flavor. It is registered
    // after single-instance so test builds preserve the production plugin-order invariant.
    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
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
            #[cfg(feature = "e2e")]
            commands::workspace::prepare_e2e_workspace,
            commands::workspace::authorize_workspace_selection,
            commands::workspace::cancel_workspace_selection,
            commands::workspace::validate_recent_workspace,
            commands::workspace::get_workspace_launcher_snapshot,
            commands::workspace::get_workspace_workbench_snapshot,
            commands::workspace::remove_recent_workspace,
            commands::workspace::remove_workspace_session,
            window::coordinate_workspace_open,
            window::create_plainroot_window,
            window::close_plainroot_window,
            window::take_second_instance_open_requests,
            window::set_workbench_window_title,
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
            let migrated_state = match window::migrate_legacy_window_labels(&persistent_state) {
                Ok(state) => state,
                Err(error) => {
                    eprintln!(
                        "Plainroot window-label migration failed: {}",
                        error.message_key
                    );
                    persistent_state.snapshot().unwrap_or_default()
                }
            };
            let cleanup_roots = migrated_state
                .recent_workspaces
                .iter()
                .map(|workspace| workspace.canonical_root.clone())
                .collect::<Vec<_>>();
            let window_coordinator = window::WorkspaceWindowCoordinator::from_sessions(
                &migrated_state.workspace_sessions,
            );
            if let Some(error) = persistent_state.current_error() {
                eprintln!(
                    "Plainroot state initialization failed: {}",
                    error.message_key
                );
            }
            app.manage(window_coordinator);
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
