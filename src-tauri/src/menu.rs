use tauri::menu::AboutMetadata;
use tauri::{
    menu::{Menu, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder},
    AppHandle, Emitter, Manager, Runtime,
};

use crate::window::WorkspaceWindowCoordinator;
use crate::window::APP_NAME;
use crate::{commands::workspace::WorkspaceAccessService, state::PersistentAppState};

pub const NEW_WINDOW_ID: &str = "file.new_window";
pub const CLOSE_WINDOW_ID: &str = "file.close_window";
pub const OPEN_FOLDER_ID: &str = "file.open_folder";
pub const OPEN_MARKDOWN_ID: &str = "file.open_markdown";
pub const HELP_ID: &str = "help.plainroot";
pub const LAUNCHER_MENU_EVENT: &str = "plainroot://launcher-menu";

pub fn build_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let open_folder = custom_item(app, OPEN_FOLDER_ID, "打开文件夹…", Some("CmdOrCtrl+O"))?;
    let open_markdown = custom_item(
        app,
        OPEN_MARKDOWN_ID,
        "打开 Markdown 文件…",
        Some("CmdOrCtrl+Shift+O"),
    )?;
    let new_window = custom_item(app, NEW_WINDOW_ID, "新建窗口", Some("CmdOrCtrl+Shift+N"))?;
    let close_window = custom_item(app, CLOSE_WINDOW_ID, "关闭窗口", Some("CmdOrCtrl+W"))?;

    let file_builder = SubmenuBuilder::new(app, "文件")
        .item(&new_window)
        .item(&open_folder)
        .item(&open_markdown)
        .separator()
        .item(&close_window);
    #[cfg(not(target_os = "macos"))]
    let file_builder = file_builder.separator().quit_with_text("退出 Plainroot");
    let file_menu = file_builder.build()?;

    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .item(&custom_item(app, "edit.undo", "撤销", Some("CmdOrCtrl+Z"))?)
        .item(&custom_item(
            app,
            "edit.redo",
            "重做",
            Some("CmdOrCtrl+Shift+Z"),
        )?)
        .separator()
        .item(&custom_item(app, "edit.cut", "剪切", Some("CmdOrCtrl+X"))?)
        .item(&custom_item(app, "edit.copy", "复制", Some("CmdOrCtrl+C"))?)
        .item(&custom_item(
            app,
            "edit.paste",
            "粘贴",
            Some("CmdOrCtrl+V"),
        )?)
        .item(&custom_item(
            app,
            "edit.select_all",
            "全选",
            Some("CmdOrCtrl+A"),
        )?)
        .build()?;

    let view_builder = SubmenuBuilder::new(app, "显示")
        .item(&custom_item(
            app,
            "view.toggle_sidebar",
            "切换侧栏",
            Some("CmdOrCtrl+\\"),
        )?)
        .item(&custom_item(
            app,
            "view.search",
            "搜索工作区",
            Some("CmdOrCtrl+Shift+F"),
        )?);
    #[cfg(target_os = "macos")]
    let view_builder = view_builder.separator().fullscreen_with_text("进入全屏");
    let view_menu = view_builder.build()?;

    let window_builder = SubmenuBuilder::new(app, "窗口")
        .minimize_with_text("最小化")
        .maximize_with_text("缩放");
    #[cfg(target_os = "macos")]
    let window_builder = window_builder
        .separator()
        .bring_all_to_front_with_text("前置全部窗口");
    let window_menu = window_builder.build()?;

    let help_builder =
        SubmenuBuilder::new(app, "帮助").item(&custom_item(app, HELP_ID, "Plainroot 帮助", None)?);
    #[cfg(not(target_os = "macos"))]
    let help_builder = help_builder
        .separator()
        .about_with_text("关于 Plainroot", Some(about_metadata(app)));
    let help_menu = help_builder.build()?;

    #[cfg(target_os = "macos")]
    let menu_builder = {
        let app_menu = SubmenuBuilder::new(app, APP_NAME)
            .about_with_text("关于 Plainroot", Some(about_metadata(app)))
            .separator()
            .services_with_text("服务")
            .separator()
            .hide_with_text("隐藏 Plainroot")
            .hide_others_with_text("隐藏其他")
            .show_all_with_text("全部显示")
            .separator()
            .quit_with_text("退出 Plainroot")
            .build()?;
        MenuBuilder::new(app).item(&app_menu)
    };
    #[cfg(not(target_os = "macos"))]
    let menu_builder = MenuBuilder::new(app);

    menu_builder
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()
}

fn about_metadata<R: Runtime>(app: &AppHandle<R>) -> AboutMetadata<'static> {
    AboutMetadata {
        name: Some(APP_NAME.to_owned()),
        version: Some(app.package_info().version.to_string()),
        ..Default::default()
    }
}

pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let result = match id {
        NEW_WINDOW_ID => app
            .state::<WorkspaceWindowCoordinator>()
            .create_launcher(app)
            .map(|_| ()),
        CLOSE_WINDOW_ID => {
            let label = app
                .webview_windows()
                .into_values()
                .find(|window| window.is_focused().unwrap_or(false))
                .map(|window| window.label().to_owned())
                .ok_or_else(|| {
                    crate::error::DesktopError::new(
                        crate::error::DesktopErrorCode::WindowNotFound,
                        true,
                        true,
                    )
                });
            label.and_then(|label| {
                app.state::<WorkspaceWindowCoordinator>()
                    .close_window(
                        app,
                        &label,
                        &app.state::<WorkspaceAccessService>(),
                        &app.state::<PersistentAppState>(),
                    )
                    .map(|_| ())
            })
        }
        OPEN_FOLDER_ID | OPEN_MARKDOWN_ID => app
            .webview_windows()
            .into_values()
            .find(|window| window.is_focused().unwrap_or(false))
            .ok_or_else(|| {
                crate::error::DesktopError::new(
                    crate::error::DesktopErrorCode::WindowNotFound,
                    true,
                    true,
                )
            })
            .and_then(|window| {
                window.emit(LAUNCHER_MENU_EVENT, id).map_err(|_| {
                    crate::error::DesktopError::new(
                        crate::error::DesktopErrorCode::WindowFocusFailed,
                        true,
                        true,
                    )
                })
            }),
        _ => return,
    };

    if let Err(error) = result {
        eprintln!("Plainroot desktop action failed: {}", error.message_key);
    }
}

fn custom_item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    text: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    let mut builder = MenuItemBuilder::with_id(id, text).enabled(custom_menu_enabled(id));
    if let Some(accelerator) = accelerator {
        builder = builder.accelerator(accelerator);
    }
    builder.build(app)
}

fn custom_menu_enabled(id: &str) -> bool {
    matches!(
        id,
        NEW_WINDOW_ID | CLOSE_WINDOW_ID | OPEN_FOLDER_ID | OPEN_MARKDOWN_ID
    )
}

#[cfg(test)]
mod tests {
    use super::{
        custom_menu_enabled, CLOSE_WINDOW_ID, NEW_WINDOW_ID, OPEN_FOLDER_ID, OPEN_MARKDOWN_ID,
    };

    #[test]
    fn only_implemented_custom_menu_actions_are_enabled() {
        assert!(custom_menu_enabled(NEW_WINDOW_ID));
        assert!(custom_menu_enabled(CLOSE_WINDOW_ID));
        assert!(custom_menu_enabled(OPEN_FOLDER_ID));
        assert!(custom_menu_enabled(OPEN_MARKDOWN_ID));
        assert!(!custom_menu_enabled("edit.copy"));
        assert!(!custom_menu_enabled("view.search"));
    }
}
