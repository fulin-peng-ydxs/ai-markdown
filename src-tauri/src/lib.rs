use tauri::Manager;

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
        .menu(menu::build_app_menu)
        .on_menu_event(|app, event| menu::handle_menu_event(app, event.id().as_ref()))
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
