use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::error::{DesktopError, DesktopErrorCode};

pub const APP_NAME: &str = "Plainroot";
pub const DEFAULT_WINDOW_WIDTH: f64 = 1100.0;
pub const DEFAULT_WINDOW_HEIGHT: f64 = 720.0;
pub const MIN_WINDOW_WIDTH: f64 = 720.0;
pub const MIN_WINDOW_HEIGHT: f64 = 520.0;

const LAUNCHER_WINDOW_PREFIX: &str = "launcher-";

pub fn launcher_title() -> String {
    APP_NAME.to_owned()
}

pub fn document_title(workspace_name: &str, file_name: Option<&str>) -> String {
    let workspace_name = workspace_name.trim();
    let file_name = file_name.map(str::trim).filter(|name| !name.is_empty());

    match (workspace_name.is_empty(), file_name) {
        (false, Some(file_name)) => format!("{workspace_name} — {file_name} — {APP_NAME}"),
        (false, None) => format!("{workspace_name} — {APP_NAME}"),
        (true, _) => launcher_title(),
    }
}

pub fn create_launcher_window<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<WebviewWindow<R>, DesktopError> {
    let label = next_launcher_label(app);
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(launcher_title())
        .inner_size(DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT)
        .min_inner_size(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        .resizable(true)
        .decorations(true)
        .focused(true)
        .center()
        .prevent_overflow()
        .build()
        .map_err(|_| window_error(DesktopErrorCode::WindowCreateFailed))
}

pub fn focus_window<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<(), DesktopError> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| window_error(DesktopErrorCode::WindowNotFound))?;

    window
        .unminimize()
        .and_then(|_| window.show())
        .and_then(|_| window.set_focus())
        .map_err(|_| window_error(DesktopErrorCode::WindowFocusFailed))
}

pub fn close_window<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<(), DesktopError> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| window_error(DesktopErrorCode::WindowNotFound))?;

    window
        .close()
        .map_err(|_| window_error(DesktopErrorCode::WindowCloseFailed))
}

pub fn close_focused_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), DesktopError> {
    let window = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .ok_or_else(|| window_error(DesktopErrorCode::WindowNotFound))?;

    close_window(app, window.label())
}

fn next_launcher_label<R: Runtime>(app: &AppHandle<R>) -> String {
    (1_u64..)
        .map(|index| format!("{LAUNCHER_WINDOW_PREFIX}{index}"))
        .find(|label| app.get_webview_window(label).is_none())
        .expect("launcher window label space should not be exhausted")
}

fn window_error(code: DesktopErrorCode) -> DesktopError {
    DesktopError::new(code, true, true)
}

#[cfg(test)]
mod tests {
    use tauri::test::mock_app;

    use super::{
        close_window, create_launcher_window, document_title, focus_window, launcher_title,
    };
    use crate::error::DesktopErrorCode;

    #[test]
    fn titles_follow_launcher_and_workspace_contract() {
        assert_eq!(launcher_title(), "Plainroot");
        assert_eq!(document_title("notes", None), "notes — Plainroot");
        assert_eq!(
            document_title("notes", Some("roadmap.md")),
            "notes — roadmap.md — Plainroot"
        );
        assert_eq!(document_title("  ", Some("ignored.md")), "Plainroot");
    }

    #[test]
    fn launcher_windows_receive_unique_labels_and_can_be_focused_and_closed() {
        let app = mock_app();

        let first = create_launcher_window(app.handle()).expect("first launcher should be created");
        let second =
            create_launcher_window(app.handle()).expect("second launcher should be created");

        assert_eq!(first.label(), "launcher-1");
        assert_eq!(second.label(), "launcher-2");
        focus_window(app.handle(), first.label()).expect("launcher should be focusable");
        close_window(app.handle(), first.label()).expect("launcher should be closable");
    }

    #[test]
    fn missing_window_returns_stable_error_instead_of_claiming_success() {
        let app = mock_app();

        let error = focus_window(app.handle(), "missing").expect_err("window should be missing");

        assert_eq!(error.code, DesktopErrorCode::WindowNotFound);
        assert!(error.content_safe);
        assert!(error.retryable);
    }
}
