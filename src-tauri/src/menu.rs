use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::AboutMetadata;
use tauri::{
    menu::{
        CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem, MenuItemBuilder,
        MenuItemKind, SubmenuBuilder,
    },
    AppHandle, Emitter, Manager, Runtime, State, WebviewWindow,
};

use crate::error::{DesktopError, DesktopErrorCode};
use crate::window::APP_NAME;
use crate::window::{WindowSettlementCoordinator, WorkspaceWindowCoordinator};
use crate::{commands::workspace::WorkspaceAccessService, state::PersistentAppState};

pub const NEW_WINDOW_ID: &str = "file.new_window";
pub const CLOSE_WINDOW_ID: &str = "file.close_window";
pub const OPEN_FOLDER_ID: &str = "file.open_folder";
pub const OPEN_MARKDOWN_ID: &str = "file.open_markdown";
pub const SAVE_ID: &str = "file.save";
pub const SAVE_COPY_ID: &str = "file.save_copy";
pub const UNDO_ID: &str = "edit.undo";
pub const REDO_ID: &str = "edit.redo";
pub const FIND_ID: &str = "edit.find";
pub const VISUAL_MODE_ID: &str = "view.visual";
pub const SOURCE_MODE_ID: &str = "view.source";
pub const CLOSE_CURRENT_TAB_ID: &str = "tab.close_current";
pub const REOPEN_CLOSED_TAB_ID: &str = "tab.reopen_closed";
pub const NEXT_TAB_ID: &str = "tab.next";
pub const PREVIOUS_TAB_ID: &str = "tab.previous";
pub const CLOSE_OTHER_TABS_ID: &str = "tab.close_others";
pub const CLOSE_RIGHT_TABS_ID: &str = "tab.close_right";
pub const CLOSE_ALL_TABS_ID: &str = "tab.close_all";
pub const SHOW_ALL_TABS_ID: &str = "tab.show_all";
pub const WORKSPACE_OPEN_PREFERENCES_ID: &str = "app.workspace_open_preferences";
pub const HELP_ID: &str = "help.plainroot";
pub const LAUNCHER_MENU_EVENT: &str = "plainroot://launcher-menu";
pub const WORKBENCH_MENU_EVENT: &str = "plainroot://workbench-menu";
const CLOSE_WINDOW_ACCELERATOR: &str = "CmdOrCtrl+Shift+W";

const WORKBENCH_ACTION_IDS: &[&str] = &[
    SAVE_ID,
    SAVE_COPY_ID,
    UNDO_ID,
    REDO_ID,
    FIND_ID,
    VISUAL_MODE_ID,
    SOURCE_MODE_ID,
    CLOSE_CURRENT_TAB_ID,
    REOPEN_CLOSED_TAB_ID,
    NEXT_TAB_ID,
    PREVIOUS_TAB_ID,
    CLOSE_OTHER_TABS_ID,
    CLOSE_RIGHT_TABS_ID,
    CLOSE_ALL_TABS_ID,
    SHOW_ALL_TABS_ID,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditorMenuMode {
    Visual,
    Source,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabMenuState {
    pub tab_count: u32,
    pub active_tab_index: Option<u32>,
    pub recently_closed_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorMenuState {
    pub has_document: bool,
    pub read_only: bool,
    pub busy: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    pub mode: Option<EditorMenuMode>,
    pub tabs: TabMenuState,
}

impl Default for EditorMenuState {
    fn default() -> Self {
        Self {
            has_document: false,
            read_only: true,
            busy: false,
            can_undo: false,
            can_redo: false,
            mode: None,
            tabs: TabMenuState::default(),
        }
    }
}

#[derive(Default)]
pub struct EditorMenuStateRegistry {
    windows: Mutex<HashMap<String, EditorMenuState>>,
}

impl EditorMenuStateRegistry {
    fn update(&self, window_label: &str, state: EditorMenuState) -> Result<(), DesktopError> {
        self.windows
            .lock()
            .map_err(|_| menu_update_error())?
            .insert(window_label.to_owned(), state);
        Ok(())
    }

    fn remove(&self, window_label: &str) -> Result<(), DesktopError> {
        self.windows
            .lock()
            .map_err(|_| menu_update_error())?
            .remove(window_label);
        Ok(())
    }

    pub fn state_for(&self, window_label: &str) -> Result<EditorMenuState, DesktopError> {
        Ok(self
            .windows
            .lock()
            .map_err(|_| menu_update_error())?
            .get(window_label)
            .copied()
            .unwrap_or_default())
    }
}

pub fn build_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let open_folder = custom_item(app, OPEN_FOLDER_ID, "打开文件夹…", Some("CmdOrCtrl+O"))?;
    let open_markdown = custom_item(
        app,
        OPEN_MARKDOWN_ID,
        "打开 Markdown 文件…",
        Some("CmdOrCtrl+Shift+O"),
    )?;
    let new_window = custom_item(app, NEW_WINDOW_ID, "新建窗口", Some("CmdOrCtrl+Shift+N"))?;
    let close_window = custom_item(
        app,
        CLOSE_WINDOW_ID,
        "关闭窗口",
        Some(CLOSE_WINDOW_ACCELERATOR),
    )?;
    let save = custom_item(app, SAVE_ID, "保存", Some("CmdOrCtrl+S"))?;
    let save_copy = custom_item(app, SAVE_COPY_ID, "另存副本…", Some("CmdOrCtrl+Shift+S"))?;
    let workspace_open_preferences = custom_item(
        app,
        WORKSPACE_OPEN_PREFERENCES_ID,
        "工作区打开方式…",
        Some("CmdOrCtrl+,"),
    )?;

    let file_builder = SubmenuBuilder::new(app, "文件")
        .item(&new_window)
        .item(&open_folder)
        .item(&open_markdown)
        .separator()
        .item(&save)
        .item(&save_copy)
        .separator()
        .item(&close_window);
    #[cfg(not(target_os = "macos"))]
    let file_builder = file_builder
        .separator()
        .item(&workspace_open_preferences)
        .separator()
        .quit_with_text("退出 Plainroot");
    let file_menu = file_builder.build()?;

    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .item(&custom_item(app, UNDO_ID, "撤销", Some("CmdOrCtrl+Z"))?)
        .item(&custom_item(
            app,
            REDO_ID,
            "重做",
            Some("CmdOrCtrl+Shift+Z"),
        )?)
        .separator()
        // Clipboard roles remain native so the focused CodeMirror/ProseMirror surface receives
        // platform-correct cut/copy/paste/select-all behavior without a second JS shortcut path.
        .cut_with_text("剪切")
        .copy_with_text("复制")
        .paste_with_text("粘贴")
        .select_all_with_text("全选")
        .separator()
        .item(&custom_item(
            app,
            FIND_ID,
            "在当前文档中查找…",
            Some("CmdOrCtrl+F"),
        )?)
        .build()?;

    let visual_mode = custom_check_item(app, VISUAL_MODE_ID, "排版编辑", Some("CmdOrCtrl+Alt+1"))?;
    let source_mode = custom_check_item(
        app,
        SOURCE_MODE_ID,
        "Markdown 源码",
        Some("CmdOrCtrl+Alt+2"),
    )?;
    let view_builder = SubmenuBuilder::new(app, "显示")
        .item(&visual_mode)
        .item(&source_mode)
        .separator()
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

    let tab_menu = SubmenuBuilder::new(app, "页签")
        .item(&custom_item(
            app,
            CLOSE_CURRENT_TAB_ID,
            "关闭当前页签",
            Some("CmdOrCtrl+W"),
        )?)
        .item(&custom_item(
            app,
            REOPEN_CLOSED_TAB_ID,
            "重新打开最近关闭的页签",
            Some("CmdOrCtrl+Shift+T"),
        )?)
        .separator()
        .item(&custom_item(
            app,
            NEXT_TAB_ID,
            "下一个页签",
            Some("Ctrl+Tab"),
        )?)
        .item(&custom_item(
            app,
            PREVIOUS_TAB_ID,
            "上一个页签",
            Some("Ctrl+Shift+Tab"),
        )?)
        .separator()
        .item(&custom_item(
            app,
            CLOSE_OTHER_TABS_ID,
            "关闭其他页签",
            None,
        )?)
        .item(&custom_item(
            app,
            CLOSE_RIGHT_TABS_ID,
            "关闭右侧页签",
            None,
        )?)
        .item(&custom_item(app, CLOSE_ALL_TABS_ID, "关闭全部页签", None)?)
        .separator()
        .item(&custom_item(app, SHOW_ALL_TABS_ID, "所有页签…", None)?)
        .build()?;

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
            .item(&workspace_open_preferences)
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
        .item(&tab_menu)
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
                let coordinator = app.state::<WorkspaceWindowCoordinator>();
                if coordinator.workspace_for_window(&label)?.is_some() {
                    app.state::<WindowSettlementCoordinator>()
                        .request_close(app, &label)
                        .map(|_| ())
                } else {
                    coordinator
                        .close_window(
                            app,
                            &label,
                            &app.state::<WorkspaceAccessService>(),
                            &app.state::<PersistentAppState>(),
                        )
                        .map(|_| ())
                }
            })
        }
        OPEN_FOLDER_ID | OPEN_MARKDOWN_ID | WORKSPACE_OPEN_PREFERENCES_ID => focused_window(app)
            .and_then(|window| {
                window
                    .emit(LAUNCHER_MENU_EVENT, id)
                    .map_err(|_| DesktopError::new(DesktopErrorCode::WindowFocusFailed, true, true))
            }),
        action if WORKBENCH_ACTION_IDS.contains(&action) => {
            focused_window(app).and_then(|window| {
                window
                    .emit(WORKBENCH_MENU_EVENT, action)
                    .map_err(|_| DesktopError::new(DesktopErrorCode::MenuUpdateFailed, true, true))
            })
        }
        _ => return,
    };

    if let Err(error) = result {
        eprintln!("Plainroot desktop action failed: {}", error.message_key);
    }
}

#[tauri::command]
pub fn update_editor_menu_state<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: EditorMenuState,
    registry: State<'_, EditorMenuStateRegistry>,
) -> Result<(), DesktopError> {
    registry.update(window.label(), state)?;
    if window.is_focused().unwrap_or(false) {
        apply_editor_menu_state(&app, state)?;
    }
    Ok(())
}

#[tauri::command]
pub fn reset_editor_menu_state<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    registry: State<'_, EditorMenuStateRegistry>,
) -> Result<(), DesktopError> {
    registry.remove(window.label())?;
    if window.is_focused().unwrap_or(false) {
        apply_editor_menu_state(&app, EditorMenuState::default())?;
    }
    Ok(())
}

pub fn apply_window_editor_menu_state<R: Runtime>(
    app: &AppHandle<R>,
    window_label: &str,
    registry: &EditorMenuStateRegistry,
) -> Result<(), DesktopError> {
    apply_editor_menu_state(app, registry.state_for(window_label)?)
}

pub fn forget_window_editor_menu_state(
    window_label: &str,
    registry: &EditorMenuStateRegistry,
) -> Result<(), DesktopError> {
    registry.remove(window_label)
}

fn focused_window<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::WebviewWindow<R>, DesktopError> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .ok_or_else(|| DesktopError::new(DesktopErrorCode::WindowNotFound, true, true))
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

fn custom_check_item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    text: &str,
    accelerator: Option<&str>,
) -> tauri::Result<CheckMenuItem<R>> {
    let mut builder = CheckMenuItemBuilder::with_id(id, text).enabled(custom_menu_enabled(id));
    if let Some(accelerator) = accelerator {
        builder = builder.accelerator(accelerator);
    }
    builder.build(app)
}

fn custom_menu_enabled(id: &str) -> bool {
    matches!(
        id,
        NEW_WINDOW_ID
            | CLOSE_WINDOW_ID
            | OPEN_FOLDER_ID
            | OPEN_MARKDOWN_ID
            | WORKSPACE_OPEN_PREFERENCES_ID
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct EditorMenuPolicy {
    save: bool,
    save_copy: bool,
    undo: bool,
    redo: bool,
    find: bool,
    visual: bool,
    source: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TabMenuPolicy {
    close_current: bool,
    reopen_closed: bool,
    next: bool,
    previous: bool,
    close_others: bool,
    close_right: bool,
    close_all: bool,
    show_all: bool,
}

fn editor_menu_policy(state: EditorMenuState) -> EditorMenuPolicy {
    let available = state.has_document && !state.busy;
    let editable = available && !state.read_only;
    EditorMenuPolicy {
        save: editable,
        save_copy: available,
        undo: editable && state.can_undo,
        redo: editable && state.can_redo,
        find: available,
        visual: available && state.mode != Some(EditorMenuMode::Visual),
        source: available && state.mode != Some(EditorMenuMode::Source),
    }
}

fn tab_menu_policy(state: EditorMenuState) -> TabMenuPolicy {
    let active_index = state.tabs.active_tab_index;
    let has_active = active_index.is_some_and(|index| index < state.tabs.tab_count);
    let multiple = has_active && state.tabs.tab_count > 1;
    let available = !state.busy;
    TabMenuPolicy {
        close_current: available && has_active,
        reopen_closed: available && state.tabs.recently_closed_count > 0,
        next: available && multiple,
        previous: available && multiple,
        close_others: available && multiple,
        close_right: available
            && has_active
            && active_index.is_some_and(|index| index < state.tabs.tab_count.saturating_sub(1)),
        close_all: available && has_active,
        show_all: available && (state.tabs.tab_count > 0 || state.tabs.recently_closed_count > 0),
    }
}

fn apply_editor_menu_state<R: Runtime>(
    app: &AppHandle<R>,
    state: EditorMenuState,
) -> Result<(), DesktopError> {
    let menu = app.menu().ok_or_else(menu_update_error)?;
    let policy = editor_menu_policy(state);
    let tab_policy = tab_menu_policy(state);
    for (id, enabled) in [
        (SAVE_ID, policy.save),
        (SAVE_COPY_ID, policy.save_copy),
        (UNDO_ID, policy.undo),
        (REDO_ID, policy.redo),
        (FIND_ID, policy.find),
        (VISUAL_MODE_ID, policy.visual),
        (SOURCE_MODE_ID, policy.source),
        (CLOSE_CURRENT_TAB_ID, tab_policy.close_current),
        (REOPEN_CLOSED_TAB_ID, tab_policy.reopen_closed),
        (NEXT_TAB_ID, tab_policy.next),
        (PREVIOUS_TAB_ID, tab_policy.previous),
        (CLOSE_OTHER_TABS_ID, tab_policy.close_others),
        (CLOSE_RIGHT_TABS_ID, tab_policy.close_right),
        (CLOSE_ALL_TABS_ID, tab_policy.close_all),
        (SHOW_ALL_TABS_ID, tab_policy.show_all),
    ] {
        let item = find_menu_item(&menu, id).ok_or_else(menu_update_error)?;
        set_item_enabled(&item, enabled)?;
    }
    set_check_item(
        &menu,
        VISUAL_MODE_ID,
        state.mode == Some(EditorMenuMode::Visual),
    )?;
    set_check_item(
        &menu,
        SOURCE_MODE_ID,
        state.mode == Some(EditorMenuMode::Source),
    )?;
    Ok(())
}

fn find_menu_item<R: Runtime>(menu: &Menu<R>, id: &str) -> Option<MenuItemKind<R>> {
    for item in menu.items().ok()? {
        if item.id().as_ref() == id {
            return Some(item);
        }
        if let MenuItemKind::Submenu(submenu) = item {
            if let Some(found) = submenu.get(id) {
                return Some(found);
            }
        }
    }
    None
}

fn set_item_enabled<R: Runtime>(item: &MenuItemKind<R>, enabled: bool) -> Result<(), DesktopError> {
    let result = match item {
        MenuItemKind::MenuItem(item) => item.set_enabled(enabled),
        MenuItemKind::Submenu(item) => item.set_enabled(enabled),
        // Clipboard roles are predefined system actions and manage availability from the
        // focused native editor surface; Plainroot never passes them to this helper.
        MenuItemKind::Predefined(_) => return Err(menu_update_error()),
        MenuItemKind::Check(item) => item.set_enabled(enabled),
        MenuItemKind::Icon(item) => item.set_enabled(enabled),
    };
    result.map_err(|_| menu_update_error())
}

fn set_check_item<R: Runtime>(menu: &Menu<R>, id: &str, checked: bool) -> Result<(), DesktopError> {
    match find_menu_item(menu, id) {
        Some(MenuItemKind::Check(item)) => {
            item.set_checked(checked).map_err(|_| menu_update_error())
        }
        _ => Err(menu_update_error()),
    }
}

fn menu_update_error() -> DesktopError {
    DesktopError::new(DesktopErrorCode::MenuUpdateFailed, true, true)
}

#[cfg(test)]
mod tests {
    use super::{
        custom_menu_enabled, editor_menu_policy, tab_menu_policy, EditorMenuMode, EditorMenuState,
        EditorMenuStateRegistry, TabMenuState, CLOSE_CURRENT_TAB_ID, CLOSE_WINDOW_ACCELERATOR,
        CLOSE_WINDOW_ID, NEW_WINDOW_ID, OPEN_FOLDER_ID, OPEN_MARKDOWN_ID, SHOW_ALL_TABS_ID,
        WORKSPACE_OPEN_PREFERENCES_ID,
    };

    #[test]
    fn only_implemented_custom_menu_actions_are_enabled() {
        assert!(custom_menu_enabled(NEW_WINDOW_ID));
        assert!(custom_menu_enabled(CLOSE_WINDOW_ID));
        assert!(custom_menu_enabled(OPEN_FOLDER_ID));
        assert!(custom_menu_enabled(OPEN_MARKDOWN_ID));
        assert!(custom_menu_enabled(WORKSPACE_OPEN_PREFERENCES_ID));
        assert!(!custom_menu_enabled("edit.copy"));
        assert!(!custom_menu_enabled("file.save"));
        assert!(!custom_menu_enabled(CLOSE_CURRENT_TAB_ID));
        assert!(!custom_menu_enabled(SHOW_ALL_TABS_ID));
        assert!(!custom_menu_enabled("view.search"));
    }

    #[test]
    fn close_window_keeps_the_tab_shortcut_available_for_later_stages() {
        assert_eq!(CLOSE_WINDOW_ACCELERATOR, "CmdOrCtrl+Shift+W");
    }

    #[test]
    fn editor_menu_policy_tracks_document_permissions_busy_state_and_history() {
        let ready = EditorMenuState {
            has_document: true,
            read_only: false,
            busy: false,
            can_undo: true,
            can_redo: false,
            mode: Some(EditorMenuMode::Visual),
            tabs: TabMenuState {
                tab_count: 3,
                active_tab_index: Some(1),
                recently_closed_count: 1,
            },
        };
        let policy = editor_menu_policy(ready);
        assert!(policy.save);
        assert!(policy.save_copy);
        assert!(policy.undo);
        assert!(!policy.redo);
        assert!(!policy.visual);
        assert!(policy.source);

        let readonly = editor_menu_policy(EditorMenuState {
            read_only: true,
            ..ready
        });
        assert!(!readonly.save);
        assert!(readonly.save_copy);
        assert!(!readonly.undo);
        assert!(readonly.find);

        let busy = editor_menu_policy(EditorMenuState {
            busy: true,
            ..ready
        });
        assert_eq!(
            busy,
            super::EditorMenuPolicy {
                save: false,
                save_copy: false,
                undo: false,
                redo: false,
                find: false,
                visual: false,
                source: false,
            }
        );
    }

    #[test]
    fn tab_menu_policy_tracks_the_focused_windows_collection() {
        let state = EditorMenuState {
            tabs: TabMenuState {
                tab_count: 3,
                active_tab_index: Some(1),
                recently_closed_count: 2,
            },
            ..EditorMenuState::default()
        };
        assert_eq!(
            tab_menu_policy(state),
            super::TabMenuPolicy {
                close_current: true,
                reopen_closed: true,
                next: true,
                previous: true,
                close_others: true,
                close_right: true,
                close_all: true,
                show_all: true,
            }
        );

        let last = tab_menu_policy(EditorMenuState {
            tabs: TabMenuState {
                active_tab_index: Some(2),
                ..state.tabs
            },
            ..state
        });
        assert!(!last.close_right);

        let busy = tab_menu_policy(EditorMenuState {
            busy: true,
            ..state
        });
        assert_eq!(
            busy,
            super::TabMenuPolicy {
                close_current: false,
                reopen_closed: false,
                next: false,
                previous: false,
                close_others: false,
                close_right: false,
                close_all: false,
                show_all: false,
            }
        );

        let invalid_active = tab_menu_policy(EditorMenuState {
            tabs: TabMenuState {
                active_tab_index: Some(u32::MAX),
                ..state.tabs
            },
            ..state
        });
        assert!(!invalid_active.close_current);
        assert!(!invalid_active.close_right);
        assert!(!invalid_active.next);
    }

    #[test]
    fn menu_state_registry_keeps_each_windows_tab_state_independent() {
        let registry = EditorMenuStateRegistry::default();
        let first = EditorMenuState {
            tabs: TabMenuState {
                tab_count: 2,
                active_tab_index: Some(0),
                recently_closed_count: 1,
            },
            ..EditorMenuState::default()
        };
        let second = EditorMenuState {
            tabs: TabMenuState {
                tab_count: 1,
                active_tab_index: Some(0),
                recently_closed_count: 0,
            },
            ..EditorMenuState::default()
        };

        registry.update("first", first).unwrap();
        registry.update("second", second).unwrap();

        assert_eq!(registry.state_for("first").unwrap(), first);
        assert_eq!(registry.state_for("second").unwrap(), second);
        assert_eq!(
            registry.state_for("launcher").unwrap(),
            EditorMenuState::default()
        );
    }

    #[test]
    fn editor_menu_state_contract_matches_typescript() {
        crate::contract_test::assert_interface_matches("TabMenuState", &TabMenuState::default());
        crate::contract_test::assert_interface_matches(
            "EditorMenuState",
            &EditorMenuState::default(),
        );
        assert_eq!(
            crate::contract_test::typescript_string_constant_values("WORKBENCH_MENU_ACTIONS"),
            super::WORKBENCH_ACTION_IDS
        );
    }
}
