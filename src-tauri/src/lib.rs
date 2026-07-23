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
pub mod editor;
pub mod error;
pub mod fs;
pub mod menu;
pub mod preferences;
pub mod state;
pub mod window;

#[cfg(test)]
mod contract_test;
#[cfg(test)]
pub(crate) mod test_support;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[cfg(feature = "desktop-runtime")]
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

    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::workspace::WorkspaceAccessService::default())
        .manage(fs::scan::WorkspaceScanService::default())
        .manage(fs::watch::WorkspaceWatchService::default())
        .manage(mutations)
        .manage(deletions)
        .manage(menu::EditorMenuStateRegistry::default())
        .manage(window::WindowSettlementCoordinator::default())
        .menu(menu::build_app_menu)
        .on_menu_event(|app, event| menu::handle_menu_event(app, event.id().as_ref()))
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Focused(true) => {
                if let Err(error) = menu::apply_window_editor_menu_state(
                    window.app_handle(),
                    window.label(),
                    &window.app_handle().state::<menu::EditorMenuStateRegistry>(),
                ) {
                    eprintln!(
                        "Plainroot menu focus synchronization failed: {}",
                        error.message_key
                    );
                }
            }
            tauri::WindowEvent::Destroyed => {
                if let Err(error) = menu::forget_window_editor_menu_state(
                    window.label(),
                    &window.app_handle().state::<menu::EditorMenuStateRegistry>(),
                ) {
                    eprintln!("Plainroot menu state cleanup failed: {}", error.message_key);
                }
            }
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let app = window.app_handle();
                let settlement = app.state::<window::WindowSettlementCoordinator>();
                if settlement.take_close_bypass(window.label()) {
                    return;
                }
                let coordinator = app.state::<window::WorkspaceWindowCoordinator>();
                let Ok(Some(_)) = coordinator.workspace_for_window(window.label()) else {
                    return;
                };
                api.prevent_close();
                if let Err(error) = settlement.request_close(app, window.label()) {
                    eprintln!(
                        "Plainroot close settlement request failed: {}",
                        error.message_key
                    );
                }
            }
            _ => {}
        })
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
            window::resolve_window_settlement,
            window::take_second_instance_open_requests,
            window::set_workbench_window_title,
            menu::update_editor_menu_state,
            menu::reset_editor_menu_state,
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
            commands::editor::list_recovery_snapshots,
            commands::editor::get_recovery_snapshot,
            commands::editor::upsert_recovery_snapshot,
            commands::editor::delete_recovery_snapshot,
            commands::editor::cleanup_recovery_snapshots,
            commands::editor::register_active_recovery_session,
            commands::editor::release_active_recovery_session,
            commands::editor::prepare_conflict_overwrite,
            commands::editor::confirm_conflict_overwrite,
            commands::editor::cancel_conflict_overwrite,
            commands::editor::prepare_save_copy,
            commands::editor::confirm_save_copy,
            commands::editor::cancel_save_copy,
            commands::editor::get_workspace_asset_preference,
            commands::editor::set_workspace_asset_directory,
            commands::editor::reset_workspace_asset_directory,
            commands::editor::read_workspace_image,
            commands::editor::begin_asset_import_upload,
            commands::editor::upload_asset_import,
            commands::editor::select_asset_image,
            commands::editor::confirm_asset_import,
            commands::editor::cancel_asset_import,
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
            app.manage(editor::save_copy::EditorSaveService::with_operation_lock(
                operation_lock.clone(),
            ));
            app.manage(editor::assets::AssetImportService::with_operation_lock(
                operation_lock.clone(),
            ));
            let safe_writes = fs::safe_write::WorkspaceSafeWriteService::initialize_for_app(
                app.handle(),
                operation_lock.clone(),
                cleanup_roots,
            );
            if let Some(error) = safe_writes.current_error() {
                eprintln!(
                    "Plainroot safe-write initialization failed: {}",
                    error.message_key
                );
            }
            app.manage(safe_writes);
            let recovery = editor::recovery::RecoveryRepository::initialize_for_app(app.handle());
            if let Some(error) = recovery.current_error() {
                eprintln!(
                    "Plainroot recovery initialization failed: {}",
                    error.message_key
                );
            }
            app.manage(recovery);
            let preferences = preferences::PreferencesRepository::initialize_for_app(app.handle());
            if let Some(error) = preferences.current_error() {
                eprintln!(
                    "Plainroot preferences initialization failed: {}",
                    error.message_key
                );
            }
            app.manage(preferences);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Plainroot desktop shell");

    app.run(|app, event| {
        let tauri::RunEvent::ExitRequested { api, .. } = event else {
            return;
        };
        let settlement = app.state::<window::WindowSettlementCoordinator>();
        if settlement.take_exit_bypass() {
            return;
        }
        api.prevent_exit();
        if let Err(error) =
            settlement.request_quit(app, &app.state::<window::WorkspaceWindowCoordinator>())
        {
            eprintln!(
                "Plainroot quit settlement request failed: {}",
                error.message_key
            );
        }
    });
}
